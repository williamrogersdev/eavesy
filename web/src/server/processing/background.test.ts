import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { ProcessingMessage } from '@/server/processing-worker';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { DEAD_LETTER_QUEUE, deadLetterQueue, MAX_ATTEMPTS, queue, recoverStaleSegments, runCronSteps, SUMMARY_WAIT_LIMIT_MS } =
  await import('@/server/processing-worker');
const { ACCOUNT_TABLES } = await import('./cleanup');
const { PENDING_SEGMENT_GRACE_MS } = await import('./recovery');
const { SUMMARY_CLAIM_TTL_MS } = await import('./shared');
const { DEAD_LETTER_RETRY_SECONDS } = await import('./failure');
const { freeCancelledImports, pruneAuthRecords, stopStalledImports } = await import('./stale-records');
const { importRequest } = await import('@/server/imports/service');
const { drizzle } = await import('drizzle-orm/d1');
const schema = await import('@/db/schema');
import { createFakeEnv, delivery, stubAnthropic, summaryReply } from '@/server/testing/fake-env';

const SUMMARY = {
  title: 'Launch planning sync',
  description: 'The team planned the launch.',
  tldr: 'They agreed to ship Friday.',
  decisions: [],
  actionItems: [],
  followUps: [],
  openQuestions: [],
  topics: [],
  mentions: [],
};

let restoreFetch: (() => void) | null = null;
afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
});

function setup(opts: Parameters<typeof createFakeEnv>[0] = {}) {
  const fake = createFakeEnv(opts);
  const now = Date.now();
  fake.sqlite.run(`INSERT INTO users (id, email, email_recaps, created_at, updated_at) VALUES ('u1', 'owner@example.com', 1, ?, ?)`, [now, now]);
  fake.sqlite.run(
    `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
     VALUES ('m1', 'u1', 'Meeting recording', ?, 'desktop', 'processing', ?, ?)`,
    [now, now, now],
  );
  const addSegment = (idx: number, status: string, createdAt = now, meetingId = 'm1') => {
    fake.sqlite.run(
      `INSERT INTO meeting_segments (id, meeting_id, idx, track, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
       VALUES (?, ?, ?, 'mixed', ?, 3, ?, 240000, ?, ?)`,
      [`s${meetingId}${idx}`, meetingId, idx, `seg/${meetingId}/${idx}`, idx * 240_000, status, createdAt],
    );
    fake.objects.set(`seg/${meetingId}/${idx}`, new Uint8Array([0, idx]));
  };
  const status = (sql: string) => (fake.sqlite.query(sql).get() as { s: string } | null)?.s;
  return { ...fake, now, addSegment, status };
}

async function deliver(env: Parameters<typeof queue>[1], body: ProcessingMessage, attempts = 1) {
  const d = delivery(body, attempts);
  await queue({ messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>, env);
  return d.outcome;
}

describe('deleted meetings are not transcribed', () => {
  test('a segment of a deleted meeting is settled without calling Whisper', async () => {
    let whisperCalls = 0;
    const t = setup({ transcribe: () => (whisperCalls++, { text: 'hi', segments: [{ start: 0, end: 1, text: 'hi' }] }) });
    t.addSegment(0, 'pending');
    t.sqlite.run(`UPDATE meetings SET deleted_at = ? WHERE id = 'm1'`, [t.now]);

    expect(await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0 })).toMatchObject({ acked: true });
    expect(whisperCalls).toBe(0);
    expect(t.status(`SELECT transcribe_status s FROM meeting_segments`)).toBe('failed');
    expect(t.status(`SELECT transcribe_claimed_at s FROM meeting_segments`)).toBeNull();
  });

  test('a meeting deleted while Whisper ran leaves no claim behind', async () => {
    const t = setup({
      transcribe: () => {
        t.sqlite.run(`UPDATE meetings SET deleted_at = ? WHERE id = 'm1'`, [Date.now()]);
        return { text: 'hi', segments: [{ start: 0, end: 1, text: 'hello there everyone' }] };
      },
    });
    t.addSegment(0, 'pending');
    await deliver(t.env, { kind: 'transcribe-segment', meetingId: 'm1', idx: 0 });
    expect(t.status(`SELECT transcribe_status s FROM meeting_segments`)).toBe('failed');
    expect(t.sqlite.query(`SELECT id FROM transcript_segments`).all()).toEqual([]);
  });
});

describe('the recovery sweep', () => {
  const requeued = (t: ReturnType<typeof setup>) =>
    t.sent.filter((m) => m.body.kind === 'transcribe-segment').map((m) => (m.body as { meetingId: string; idx: number }).idx);

  test('requeues segments whose job was never queued, but not fresh ones', async () => {
    const t = setup();
    t.addSegment(0, 'pending', t.now - PENDING_SEGMENT_GRACE_MS - 1);
    t.addSegment(1, 'pending', t.now);
    await recoverStaleSegments(t.env, t.now);
    expect(requeued(t)).toEqual([0]);
  });

  test('skips deleted, failed and complete meetings, and imports still uploading', async () => {
    const t = setup();
    const old = t.now - 60 * 60 * 1_000;
    for (const [id, extra] of [
      ['gone', `deleted_at = ${old}`],
      ['failed', `status = 'failed'`],
      ['done', `status = 'complete'`],
      ['upload', `source = 'import'`],
    ] as const) {
      t.sqlite.run(
        `INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at)
         VALUES (?, 'u1', 'x', ?, 'desktop', 'processing', ?, ?)`,
        [id, old, old, old],
      );
      t.sqlite.run(`UPDATE meetings SET ${extra} WHERE id = ?`, [id]);
      t.addSegment(0, 'pending', old, id);
      t.addSegment(1, 'processing', old, id);
    }
    t.sqlite.run(
      `INSERT INTO recording_imports (meeting_id, user_id, fingerprint, segment_count, duration_ms, state, created_at)
       VALUES ('upload', 'u1', 'f', 2, 1, 'uploading', ?)`,
      [old],
    );
    t.sqlite.run(`UPDATE meeting_segments SET transcribe_claimed_at = ? WHERE transcribe_status = 'processing'`, [old]);

    await recoverStaleSegments(t.env, t.now);
    expect(t.sent).toEqual([]);
  });
});

describe('a meeting already complete', () => {
  test('re-sends every follow-up, in case the run that completed it died before queueing them', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE meetings SET status = 'complete' WHERE id = 'm1'`);
    t.sqlite.run(
      `INSERT INTO summaries (id, meeting_id, tldr, generated_by_model, generated_at) VALUES ('s1', 'm1', 'Done.', 'test', ?)`,
      [t.now],
    );
    const env = { ...t.env, RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: 'whsec_test', EMAIL_FROM: 'Eavesy <r@eavesy.test>' };

    await deliver(env, { kind: 'summarize', meetingId: 'm1' });
    expect(t.sent.map((m) => m.body)).toEqual([
      { kind: 'embed', meetingId: 'm1' },
      { kind: 'agent-transcript', meetingId: 'm1', onlyIfMissing: true },
      { kind: 'send-recap', meetingId: 'm1' },
    ]);
  });
});

describe('the final summary claim', () => {
  function ready() {
    const t = setup();
    t.addSegment(0, 'complete');
    t.sqlite.run(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text) VALUES ('t0', 'm1', 0, 1000, 'We ship Friday and the launch plan is set.')`,
    );
    const api = stubAnthropic(() => summaryReply(SUMMARY));
    restoreFetch = api.restore;
    return { ...t, api };
  }

  test('a second job checks back later instead of calling the model again', async () => {
    const t = ready();
    t.sqlite.run(`UPDATE meetings SET summary_claimed_at = ? WHERE id = 'm1'`, [Date.now()]);
    const outcome = await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    expect(outcome).toMatchObject({ acked: false, retried: true, delaySeconds: 300 });
    expect(t.api.calls).toHaveLength(0);
    expect(t.status(`SELECT status s FROM meetings`)).toBe('processing');
  });

  test('a claim left by a job that died is taken over after the TTL', async () => {
    const t = ready();
    t.sqlite.run(`UPDATE meetings SET summary_claimed_at = ? WHERE id = 'm1'`, [Date.now() - SUMMARY_CLAIM_TTL_MS - 1]);
    expect(await deliver(t.env, { kind: 'summarize', meetingId: 'm1' })).toMatchObject({ acked: true });
    expect(t.api.calls).toHaveLength(1);
    expect(t.status(`SELECT status s FROM meetings`)).toBe('complete');
    expect(t.status(`SELECT summary_claimed_at s FROM meetings`)).toBeNull();
  });

  test('the dead-letter queue leaves a meeting alone while a live job holds its summary', async () => {
    const t = setup();
    const meetingStatus = () => t.status(`SELECT status AS s FROM meetings WHERE id = 'm1'`);
    const failures: { outcome: string }[] = [];
    const deadLetter = async () => {
      const d = delivery({ kind: 'summarize', meetingId: 'm1' }, MAX_ATTEMPTS);
      await deadLetterQueue(
        { queue: DEAD_LETTER_QUEUE, messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>,
        t.env,
        (failure) => failures.push(failure),
      );
      return d.outcome;
    };
    const failRows = () =>
      t.sqlite.query(`SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'meeting.fail'`).get() as { n: number };

    t.sqlite.run(`UPDATE meetings SET summary_claimed_at = ? WHERE id = 'm1'`, [t.now]);
    expect(await deadLetter()).toMatchObject({ acked: true, retried: false });
    expect(meetingStatus()).toBe('processing');
    expect(failRows().n).toBe(0);
    expect(failures.map((f) => f.outcome)).toEqual(['left-to-live-job']);

    t.sqlite.run(`UPDATE meetings SET summary_claimed_at = ? WHERE id = 'm1'`, [t.now - SUMMARY_CLAIM_TTL_MS - 1]);
    expect(await deadLetter()).toMatchObject({ acked: true, retried: false });
    expect(meetingStatus()).toBe('failed');
    expect(failRows().n).toBe(1);
    expect(failures.map((f) => f.outcome)).toEqual(['left-to-live-job', 'recording-failed']);
  });

  test('a failed model call releases the claim for the retry', async () => {
    const t = setup();
    t.addSegment(0, 'complete');
    t.sqlite.run(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text) VALUES ('t0', 'm1', 0, 1000, 'We ship Friday and the launch plan is set.')`,
    );
    const api = stubAnthropic(() => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }));
    restoreFetch = api.restore;
    expect(await deliver(t.env, { kind: 'summarize', meetingId: 'm1' })).toMatchObject({ retried: true });
    expect(t.status(`SELECT summary_claimed_at s FROM meetings`)).toBeNull();
  });
});

describe('the hourly cron', () => {
  test('runs every step when one fails, then reports the failure', async () => {
    const ran: string[] = [];
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      runCronSteps([
        ['first', async () => void ran.push('first')],
        ['broken', async () => { throw new Error('boom'); }],
        ['last', async () => void ran.push('last')],
      ]),
    ).rejects.toThrow('cron steps failed: broken');
    expect(ran).toEqual(['first', 'last']);
    expect(error.mock.calls.map((args) => String(args[0])).join('\n')).toContain('cron step failed: broken');
    error.mockRestore();
  });

  test('the queue gives up when the consumer does', () => {
    const toml = readFileSync(join(import.meta.dir, '../../../../workers/processing/wrangler.toml'), 'utf8');
    const main = /queue = "eavesy-processing"\n[^[]*?max_retries = (\d+)/.exec(toml);
    expect(Number(main?.[1]) + 1).toBe(MAX_ATTEMPTS);
    expect(SUMMARY_WAIT_LIMIT_MS).toBeGreaterThan(0);
    // The DLQ waits out a D1 outage as long as docs/OPERATIONS.md says.
    const dlq = /queue = "eavesy-processing-dlq"\n[^[]*?max_retries = (\d+)\nretry_delay = (\d+)/.exec(toml);
    expect([Number(dlq?.[1]), Number(dlq?.[2])]).toEqual([10, DEAD_LETTER_RETRY_SECONDS]);
  });
});

describe('stale records', () => {
  const DAY = 24 * 60 * 60 * 1000;
  function importMeeting(t: ReturnType<typeof setup>, id: string, opts: { status: string; state: string; updatedAt: number; audio?: boolean }) {
    t.sqlite.run(
      `INSERT INTO meetings (id, user_id, title, started_at, source, status, audio_r2_key, created_at, updated_at)
       VALUES (?, 'u1', 'Import', ?, 'import', ?, ?, ?, ?)`,
      [id, opts.updatedAt, opts.status, opts.audio ? `users/u1/meetings/${id}/import/original.m4a` : null, opts.updatedAt, opts.updatedAt],
    );
    t.sqlite.run(
      `INSERT INTO recording_imports (meeting_id, user_id, fingerprint, segment_count, duration_ms, state, created_at)
       VALUES (?, 'u1', ?, 2, 600000, ?, ?)`,
      [id, id.padEnd(64, '0'), opts.state, opts.updatedAt],
    );
    if (opts.audio) t.objects.set(`users/u1/meetings/${id}/import/original.m4a`, new Uint8Array([1]));
  }
  function importSegment(t: ReturnType<typeof setup>, id: string, idx: number, createdAt: number) {
    const key = `users/u1/meetings/${id}/import/${idx}.wav`;
    t.sqlite.run(
      `INSERT INTO meeting_segments (id, meeting_id, idx, track, r2_key, bytes, offset_ms, duration_ms, transcribe_status, created_at)
       VALUES (?, ?, ?, 'mixed', ?, 1, 0, 300000, 'pending', ?)`,
      [`import_${id}_${idx}`, id, idx, key, createdAt],
    );
    t.objects.set(key, new Uint8Array([1]));
  }

  test('an import idle for a day is cancelled, one still uploading is not', async () => {
    const t = setup();
    importMeeting(t, 'imp_old', { status: 'uploading', state: 'uploading', updatedAt: t.now - 2 * DAY });
    importSegment(t, 'imp_old', 0, t.now - 2 * DAY);
    importMeeting(t, 'imp_busy', { status: 'uploading', state: 'uploading', updatedAt: t.now - 2 * DAY });
    importSegment(t, 'imp_busy', 0, t.now - 60_000);
    expect(await stopStalledImports(t.env, t.now)).toBe(1);
    expect(t.sqlite.query(`SELECT m.status, r.state FROM meetings m JOIN recording_imports r ON r.meeting_id = m.id WHERE m.id = 'imp_old'`).get())
      .toEqual({ status: 'failed', state: 'cancelled' });
    expect(t.status(`SELECT status s FROM meetings WHERE id = 'imp_busy'`)).toBe('uploading');
  });

  test('a cancelled import keeps its audio a week, then frees it and can be resumed from scratch', async () => {
    const t = setup();
    importMeeting(t, 'imp_week', { status: 'failed', state: 'cancelled', updatedAt: t.now - 8 * DAY, audio: true });
    importSegment(t, 'imp_week', 0, t.now - 8 * DAY);
    importMeeting(t, 'imp_new', { status: 'failed', state: 'cancelled', updatedAt: t.now - DAY, audio: true });
    importSegment(t, 'imp_new', 0, t.now - DAY);
    expect(await freeCancelledImports(t.env, t.now)).toBe(1);
    expect([...t.objects.keys()].filter((key) => key.includes('imp_week'))).toEqual([]);
    expect(t.sqlite.query(`SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = 'imp_week'`).get()).toEqual({ n: 0 });
    expect(t.status(`SELECT audio_r2_key s FROM meetings WHERE id = 'imp_week'`)).toBeNull();
    expect([...t.objects.keys()].filter((key) => key.includes('imp_new'))).toHaveLength(2);
    // Nothing left to free: the next run finds nothing.
    expect(await freeCancelledImports(t.env, t.now)).toBe(0);
  });

  test('an import resumed before its audio is freed keeps it', async () => {
    const t = setup();
    importMeeting(t, 'imp_back', { status: 'failed', state: 'cancelled', updatedAt: t.now - 8 * DAY, audio: true });
    importSegment(t, 'imp_back', 0, t.now - 8 * DAY);
    // The user resumes between the sweep's read and its claim.
    const prepare = t.env.DB.prepare.bind(t.env.DB);
    t.env.DB.prepare = ((sql: string) => {
      if (sql.startsWith("UPDATE recording_imports SET state = 'freeing'")) t.sqlite.run("UPDATE recording_imports SET state = 'uploading' WHERE meeting_id = 'imp_back'");
      return prepare(sql);
    }) as typeof t.env.DB.prepare;
    expect(await freeCancelledImports(t.env, t.now)).toBe(0);
    expect([...t.objects.keys()].filter((key) => key.includes('imp_back'))).toHaveLength(2);
    expect(t.sqlite.query(`SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = 'imp_back'`).get()).toEqual({ n: 1 });
  });

  test('an import cannot be resumed or finalized while its audio is deleted', async () => {
    const t = setup();
    importMeeting(t, 'imp_mid', { status: 'failed', state: 'cancelled', updatedAt: t.now - 8 * DAY, audio: true });
    importSegment(t, 'imp_mid', 0, t.now - 8 * DAY);
    importSegment(t, 'imp_mid', 1, t.now - 8 * DAY);
    const db = drizzle(t.env.DB as unknown as D1Database, { schema });
    const send = (path: string, method: string) =>
      importRequest(db, t.env as never, 'u1', path, new Request(`https://eavesy.test/api/imports/${path}`, { method }));
    const seen: { resume: number; state: string; finalize: number }[] = [];
    const remove = t.env.AUDIO_BUCKET.delete.bind(t.env.AUDIO_BUCKET);
    t.env.AUDIO_BUCKET.delete = (async (keys: string | string[]) => {
      // The user comes back mid-sweep: every piece still looks uploaded.
      const resume = await send('imp_mid/resume', 'POST');
      const state = (await (await send('imp_mid', 'GET')).json()) as { state: string };
      const finalize = await send('imp_mid/finalize', 'POST');
      seen.push({ resume: resume.status, state: state.state, finalize: finalize.status });
      return remove(keys);
    }) as typeof t.env.AUDIO_BUCKET.delete;
    expect(await freeCancelledImports(t.env, t.now)).toBe(1);
    expect(seen).toEqual([{ resume: 409, state: 'cancelled', finalize: 409 }]);
    expect(t.sqlite.query(`SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = 'imp_mid'`).get()).toEqual({ n: 0 });
    expect(t.status(`SELECT audio_r2_key s FROM meetings WHERE id = 'imp_mid'`)).toBeNull();
    // Once freed it resumes from scratch.
    expect(t.status(`SELECT state s FROM recording_imports WHERE meeting_id = 'imp_mid'`)).toBe('cancelled');
    expect((await send('imp_mid/resume', 'POST')).status).toBe(200);
    expect(t.status(`SELECT state s FROM recording_imports WHERE meeting_id = 'imp_mid'`)).toBe('uploading');
  });

  test('a failed object delete keeps the rows for the next run', async () => {
    const t = setup();
    importMeeting(t, 'imp_err', { status: 'failed', state: 'cancelled', updatedAt: t.now - 8 * DAY, audio: true });
    importSegment(t, 'imp_err', 0, t.now - 8 * DAY);
    const remove = t.env.AUDIO_BUCKET.delete.bind(t.env.AUDIO_BUCKET);
    t.env.AUDIO_BUCKET.delete = (async () => { throw new Error('r2 down'); }) as typeof t.env.AUDIO_BUCKET.delete;
    await expect(freeCancelledImports(t.env, t.now)).rejects.toThrow('r2 down');
    expect(t.sqlite.query(`SELECT count(*) AS n FROM meeting_segments WHERE meeting_id = 'imp_err'`).get()).toEqual({ n: 1 });
    // Still claimed, so nothing resumes onto rows whose audio may be gone.
    expect(t.status(`SELECT state s FROM recording_imports WHERE meeting_id = 'imp_err'`)).toBe('freeing');
    t.env.AUDIO_BUCKET.delete = remove;
    expect(await freeCancelledImports(t.env, t.now)).toBe(1);
    expect(t.status(`SELECT state s FROM recording_imports WHERE meeting_id = 'imp_err'`)).toBe('cancelled');
    expect([...t.objects.keys()].filter((key) => key.includes('imp_err'))).toEqual([]);
  });

  test('an import that starts uploading again before the stop lands is left alone', async () => {
    const t = setup();
    importMeeting(t, 'imp_live', { status: 'uploading', state: 'uploading', updatedAt: t.now - 2 * DAY });
    const prepare = t.env.DB.prepare.bind(t.env.DB);
    t.env.DB.prepare = ((sql: string) => {
      if (sql.startsWith('UPDATE recording_imports')) importSegment(t, 'imp_live', 0, t.now);
      return prepare(sql);
    }) as typeof t.env.DB.prepare;
    expect(await stopStalledImports(t.env, t.now)).toBe(0);
    expect(t.sqlite.query(`SELECT m.status, r.state FROM meetings m JOIN recording_imports r ON r.meeting_id = m.id WHERE m.id = 'imp_live'`).get())
      .toEqual({ status: 'uploading', state: 'uploading' });
  });

  test('old OAuth codes, unused clients and webhook ids are pruned', async () => {
    const t = setup();
    const old = t.now - 31 * DAY;
    t.sqlite.run(`INSERT INTO oauth_clients (id, name, redirect_uris_json, created_at) VALUES ('c_unused', 'a', '[]', ?), ('c_used', 'b', '[]', ?), ('c_new', 'c', '[]', ?)`, [old, old, t.now]);
    t.sqlite.run(
      `INSERT INTO mcp_tokens (id, user_id, name, token_hash, client_id, created_at) VALUES ('tok', 'u1', 'Claude', 'hash', 'c_used', ?)`,
      [old],
    );
    t.sqlite.run(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes_json, created_at, expires_at)
       VALUES ('spent', 'c_new', 'u1', 'x', 'y', '[]', ?, ?), ('live', 'c_new', 'u1', 'x', 'y', '[]', ?, ?)`,
      [old, old + 60_000, t.now, t.now + 60_000],
    );
    t.sqlite.run(`INSERT INTO provider_webhook_events (id, provider, received_at) VALUES ('old', 'resend', ?), ('new', 'resend', ?)`, [old, t.now]);
    await pruneAuthRecords(t.env, t.now);
    const ids = (sql: string) => (t.sqlite.query(sql).all() as { id: string }[]).map((row) => row.id).sort();
    expect(ids('SELECT id FROM oauth_clients')).toEqual(['c_new', 'c_used']);
    expect(ids('SELECT code_hash AS id FROM oauth_codes')).toEqual(['live']);
    expect(ids('SELECT id FROM provider_webhook_events')).toEqual(['new']);
  });
});

/** Every table with a foreign key to `users`, and the column. */
function tablesReferencingUsers(sqlite: Database) {
  const tables = (sqlite.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(
    (row) => row.name,
  );
  return tables.flatMap((table) =>
    (sqlite.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string }[])
      .filter((fk) => fk.table === 'users')
      .map(() => table),
  );
}

/** Inserts one row with every required column filled; foreign keys point at `parents`. */
function seedRow(sqlite: Database, table: string, parents: Record<string, string>) {
  const columns = sqlite.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  const fks = new Map(
    (sqlite.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string; from: string }[]).map((fk) => [
      fk.from,
      fk.table,
    ]),
  );
  const values: Record<string, unknown> = {};
  for (const column of columns) {
    const parent = fks.get(column.name);
    if (parent) {
      values[column.name] = parents[parent] ?? null;
    } else if (column.notnull || column.pk) {
      if (column.dflt_value !== null && !column.pk) continue;
      values[column.name] = /INT/i.test(column.type) ? 1 : `${table}_${column.name}`;
    }
  }
  const names = Object.keys(values);
  sqlite.run(
    `INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((name) => values[name]) as never[],
  );
  const id = values.id ?? values.code_hash ?? values.meeting_id;
  return String(id);
}

describe('deleting an account', () => {
  test('clears a row in every table that references users, with foreign keys on', async () => {
    const t = setup();
    expect(t.sqlite.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const now = Date.now();
    t.sqlite.run(`INSERT INTO users (id, created_at, updated_at) VALUES ('u2', ?, ?)`, [now, now]);

    const referencing = [...new Set(tablesReferencingUsers(t.sqlite))];
    const parents: Record<string, string> = { users: 'u1', meetings: 'm1' };
    // Parents first: a child's other foreign keys need their row to exist.
    const order = ['devices', 'calendar_connections', ...referencing.filter((x) => x !== 'meetings')];
    const seeded = new Set<string>(['meetings']);
    for (const table of order) {
      if (seeded.has(table)) continue;
      parents[table] = seedRow(t.sqlite, table, parents);
      seeded.add(table);
    }
    expect([...seeded].sort()).toEqual([...referencing].sort());
    // The same tables owned by someone else are left alone.
    t.sqlite.run(
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes_json, created_at, expires_at)
       VALUES ('other', 'c', 'u2', 'https://x', 'x', '[]', 0, 0)`,
    );

    expect(await deliver(t.env, { kind: 'purge-account', userId: 'u1' })).toMatchObject({ acked: true });

    for (const table of referencing) {
      expect({ table, rows: t.sqlite.query(`SELECT count(*) n FROM ${table} WHERE user_id = 'u1'`).get() }).toEqual({
        table,
        rows: { n: 0 },
      });
    }
    expect(t.sqlite.query(`SELECT id FROM users ORDER BY id`).all()).toEqual([{ id: 'u2' }]);
    expect(t.sqlite.query(`SELECT code_hash FROM oauth_codes`).all()).toEqual([{ code_hash: 'other' }]);
    // Purged by name, or by the helpers for bots and emails, or as the meeting rows themselves.
    const handledElsewhere = new Set(['meetings', 'meeting_bots', 'email_deliveries']);
    for (const table of referencing) {
      if (!handledElsewhere.has(table)) expect(ACCOUNT_TABLES as readonly string[]).toContain(table);
    }
  });

  test('a purge that runs out of retries is reported loudly', async () => {
    const t = setup();
    t.sqlite.run(
      `INSERT INTO meeting_bots (id, user_id, provider, meeting_url, platform, status, created_at, updated_at)
       VALUES ('b1', 'u1', 'eavesy', 'https://meet.google.com/abc-defg-hij', 'meet', 'in_call', 0, 0)`,
    );
    const env = { ...t.env, MEETING_BOTS: { stop: async () => { throw new Error('bot worker unreachable'); } } };
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await deliver(env as typeof t.env, { kind: 'purge-account', userId: 'u1' }, MAX_ATTEMPTS)).toMatchObject({
      acked: true,
    });
    expect(error.mock.calls.map((args) => String(args[0])).join('\n')).toContain('Account purge failed permanently');
    error.mockRestore();
  });
});
