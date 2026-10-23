import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { MessageBatch } from '@cloudflare/workers-types';
import type { ProcessingMessage } from '@/server/processing-worker';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { MAX_ATTEMPTS, queue, recoverStaleSegments, runCronSteps, SUMMARY_WAIT_LIMIT_MS } = await import(
  '@/server/processing-worker'
);
const { ACCOUNT_TABLES } = await import('./cleanup');
const { PENDING_SEGMENT_GRACE_MS } = await import('./recovery');
const { SUMMARY_CLAIM_TTL_MS } = await import('./shared');
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

  test('skips deleted meetings, failed meetings and imports still uploading', async () => {
    const t = setup();
    const old = t.now - 60 * 60 * 1_000;
    for (const [id, extra] of [
      ['gone', `deleted_at = ${old}`],
      ['failed', `status = 'failed'`],
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
