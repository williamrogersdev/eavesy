import { env } from 'cloudflare:workers';
import {
  applyD1Migrations,
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from 'cloudflare:test';
import type { D1Database, Queue, R2Bucket } from '@cloudflare/workers-types';
import JSZip from 'jszip';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { worker, type Env } from '../../../workers/processing/src/index';
import type { ProcessingMessage } from '../../src/server/processing-worker';
import { capBody, Route as TranscribeRoute } from '../../src/routes/api/transcribe';
import { guardSpend, guardUserQuota } from '../../src/server/rate-limit';
import { Route as ZipRoute } from '../../src/routes/api/export/$id/zip';

interface TestEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}

const testEnv = env as unknown as TestEnv;
type RouteHandler = (ctx: { request: Request; params: Record<string, string> }) => Promise<Response>;
const route = (r: { options: unknown }, method: string) =>
  (r.options as { server: { handlers: Record<string, RouteHandler> } }).server.handlers[method];

const actor = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));

// Pass-through spies: tests check that refused uploads never reach the counters.
vi.mock('../../src/server/rate-limit', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/server/rate-limit')>();
  return { ...original, guardSpend: vi.fn(original.guardSpend), guardUserQuota: vi.fn(original.guardUserQuota) };
});

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = null;
  vi.mocked(guardSpend).mockClear();
  vi.mocked(guardUserQuota).mockClear();
  await testEnv.DB.batch(
    ['transcript_segments', 'meeting_segments', 'summaries', 'activity_log', 'meetings', 'device_tokens', 'devices', 'users'].map(
      (table) => testEnv.DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

interface Logged {
  sql: string;
  args: unknown[];
}

/** Wraps D1 so a test can see every statement and count round trips. */
function recordingDb(db: D1Database) {
  const statements: Logged[] = [];
  let roundTrips = 0;
  const wrap = (inner: ReturnType<D1Database['prepare']>, sql: string, args: unknown[]): unknown => ({
    __inner: inner,
    bind: (...next: unknown[]) => wrap(inner.bind(...next), sql, next),
    run: () => (roundTrips++, statements.push({ sql, args }), inner.run()),
    all: () => (roundTrips++, statements.push({ sql, args }), inner.all()),
    first: (column?: string) => (roundTrips++, statements.push({ sql, args }), inner.first(column as never)),
    raw: (options?: unknown) => (roundTrips++, statements.push({ sql, args }), inner.raw(options as never)),
  });
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql, []);
      if (prop === 'batch') {
        return (batch: { __inner: ReturnType<D1Database['prepare']> }[]) => {
          roundTrips++;
          return target.batch(batch.map((statement) => statement.__inner));
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy, statements, roundTrips: () => roundTrips };
}

function runtimeEnv(db: D1Database, ai: { run: (model: string, input: unknown) => Promise<unknown> }): Env {
  return {
    DB: db,
    AUDIO_BUCKET: testEnv.AUDIO_BUCKET,
    VECTORIZE: { upsert: async () => ({}), deleteByIds: async () => ({}) } as unknown as Env['VECTORIZE'],
    PROCESSING_QUEUE: { send: vi.fn(async () => undefined) } as unknown as Queue<ProcessingMessage>,
    AI: ai as Env['AI'],
    ANTHROPIC_API_KEY: 'test-only',
  };
}

async function insertUser(id: string) {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
     VALUES (?, 'whisper', 'en', 0, ?, ?)`,
  )
    .bind(id, now, now)
    .run();
}

async function insertMeeting(id: string, userId: string, status: string, audioR2Key: string | null = null) {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO meetings (id, user_id, title, description, started_at, source, language, audio_r2_key, audio_format, status, created_at, updated_at)
     VALUES (?, ?, 'Scale test', '', ?, 'desktop', 'en', ?, 'm4a', ?, ?, ?)`,
  )
    .bind(id, userId, now, audioR2Key, status, now, now)
    .run();
}

const BIG_TABLES = ['meetings', 'users', 'activity_log', 'transcript_segments', 'captures', 'dictations', 'devices', 'meeting_segments'];

describe('hourly cron', () => {
  it('reads only indexed slices of large tables', async () => {
    const recorder = recordingDb(testEnv.DB);
    const controller = createScheduledController({ scheduledTime: new Date(), cron: '0 * * * *' });
    await worker.scheduled(controller, runtimeEnv(recorder.db, { run: async () => ({}) }));

    const scans: string[] = [];
    for (const { sql, args } of recorder.statements) {
      if (!/^\s*(SELECT|WITH|UPDATE|DELETE|select|with|update|delete)/.test(sql)) continue;
      const plan = await testEnv.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...args)
        .all<{ detail: string }>();
      for (const { detail } of plan.results) {
        // A scan of a partial index only visits the rows it covers.
        if (/USING (COVERING )?INDEX \w+_(deleted|byo_keys|processing)_idx/.test(detail)) continue;
        const scanned = /^SCAN (\w+)/.exec(detail)?.[1];
        if (scanned && BIG_TABLES.includes(scanned)) scans.push(`${detail}\n    in: ${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    expect(scans).toEqual([]);
  });
});

describe('transcript writes', () => {
  it('stores a long transcript in a bounded number of D1 round trips', async () => {
    await insertUser('user_batch');
    const key = 'users/user_batch/meetings/meet_batch/audio.m4a';
    await insertMeeting('meet_batch', 'user_batch', 'processing', key);
    await testEnv.AUDIO_BUCKET.put(key, new Uint8Array([1, 2, 3]));
    const lines = Array.from({ length: 120 }, (_, i) => ({ start: i, end: i + 1, text: `line ${i}` }));
    const ai = { run: vi.fn(async () => ({ text: '', segments: lines })) };
    vi.stubGlobal('fetch', async () => Response.json({ content: [{ type: 'text', text: '{"title":"t"}' }] }));

    const recorder = recordingDb(testEnv.DB);
    const batch = createMessageBatch<ProcessingMessage>('eavesy-processing', [
      { id: 'pr', timestamp: new Date(), attempts: 1, body: { kind: 'process-recording', meetingId: 'meet_batch' } },
    ]);
    await worker.queue(batch, runtimeEnv(recorder.db, ai));
    vi.unstubAllGlobals();

    expect(await getQueueResult(batch, createExecutionContext())).toMatchObject({ explicitAcks: ['pr'] });
    const stored = await testEnv.DB.prepare('SELECT count(*) AS n FROM transcript_segments WHERE meeting_id = ?')
      .bind('meet_batch')
      .first<{ n: number }>();
    expect(stored?.n).toBe(120);
    expect(recorder.roundTrips()).toBeLessThan(20);
  });
});

describe('/api/transcribe', () => {
  it('refuses an oversized upload from its declared length without reading it or spending quota', async () => {
    const token = await deviceToken('user_big');
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 64) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const response = await route(TranscribeRoute, 'POST')({
      request: new Request('https://eavesy.test/api/transcribe', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-length': String(101 * 1024 * 1024) },
        body,
        duplex: 'half',
      } as RequestInit),
      params: {},
    });
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(2);
    expect(guardUserQuota).not.toHaveBeenCalled();
    expect(guardSpend).not.toHaveBeenCalled();
  });

  it('does not spend quota on an empty or malformed upload', async () => {
    const token = await deviceToken('user_empty');
    const send = (body: BodyInit, contentType: string) =>
      route(TranscribeRoute, 'POST')({
        request: new Request('https://eavesy.test/api/transcribe', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) },
          body,
        }),
        params: {},
      });
    expect((await send(new Uint8Array(0), 'audio/wav')).status).toBe(400);
    expect((await send('not a form', 'multipart/form-data; boundary=x')).status).toBe(400);
    const form = new FormData();
    form.set('other', 'field');
    expect((await send(form, '')).status).toBe(400);
    expect(guardUserQuota).not.toHaveBeenCalled();
    expect(guardSpend).not.toHaveBeenCalled();
  });

  it('cuts off a body that runs past the cap even without a length', async () => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024;
        if (sent > 64 * 1024) controller.close();
        else controller.enqueue(new Uint8Array(1024));
      },
    });
    const capped = capBody(body, 8 * 1024);
    await expect(new Response(capped.stream).arrayBuffer()).rejects.toThrow();
    expect(capped.overflowed()).toBe(true);
    expect(sent).toBeLessThanOrEqual(12 * 1024);

    const small = capBody(new Response(new Uint8Array(4 * 1024)).body!, 8 * 1024);
    expect((await new Response(small.stream).arrayBuffer()).byteLength).toBe(4 * 1024);
    expect(small.overflowed()).toBe(false);
  });
});

describe('meeting zip export', () => {
  it('streams a valid archive with the original audio', async () => {
    await insertUser('user_zip');
    const key = 'users/user_zip/meetings/meet_zip/audio.m4a';
    const audio = new Uint8Array(512 * 1024).map((_, i) => i % 251);
    await testEnv.AUDIO_BUCKET.put(key, audio, { httpMetadata: { contentType: 'audio/mp4' } });
    await insertMeeting('meet_zip', 'user_zip', 'complete', key);
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text, is_final, is_edited)
       VALUES ('ts_zip', 'meet_zip', 0, 1000, 'Hello from the zip', 1, 0)`,
    ).run();
    actor.userId = 'user_zip';

    const response = await route(ZipRoute, 'GET')({
      request: new Request('https://eavesy.test/api/export/meet_zip/zip'),
      params: { id: 'meet_zip' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');

    // The body runs through a FixedLengthStream sized from zipLength(), which
    // errors the read if the archive comes out any other size, so a complete
    // read means the Content-Length the runtime sends is exact.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(audio.byteLength);
    const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
    const names = Object.keys(zip.files);
    const audioEntry = names.find((name) => name.endsWith('/audio.m4a'));
    expect(audioEntry).toBeTruthy();
    expect(await zip.file(audioEntry!)!.async('uint8array')).toEqual(audio);
    const transcript = names.find((name) => name.endsWith('/transcript.md'))!;
    expect(await zip.file(transcript)!.async('string')).toContain('Hello from the zip');
  }, 20_000);

  it('fails the download if the archive comes out a different size than declared', async () => {
    const short = new Response(new Uint8Array(10)).body!.pipeThrough(new FixedLengthStream(11));
    await expect(new Response(short).arrayBuffer()).rejects.toThrow();
  });

  it('is not found for another user', async () => {
    await insertUser('user_zip_owner');
    await insertUser('user_zip_other');
    await insertMeeting('meet_zip_private', 'user_zip_owner', 'complete');
    actor.userId = 'user_zip_other';
    const response = await route(ZipRoute, 'GET')({
      request: new Request('https://eavesy.test/api/export/meet_zip_private/zip'),
      params: { id: 'meet_zip_private' },
    });
    expect(response.status).toBe(404);
  });
});

async function deviceToken(userId: string): Promise<string> {
  await insertUser(userId);
  const now = Date.now();
  const deviceId = `device_${userId}`;
  await testEnv.DB.prepare(
    `INSERT INTO devices (id, user_id, name, platform, root_folder_path, last_seen_at, created_at)
     VALUES (?, ?, 'Mac', 'macos', '/tmp', ?, ?)`,
  )
    .bind(deviceId, userId, now, now)
    .run();
  const raw = `eavesy_device_${userId}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  await testEnv.DB.prepare(
    `INSERT INTO device_tokens (id, user_id, device_id, token_hash, name, created_at) VALUES (?, ?, ?, ?, 'Mac', ?)`,
  )
    .bind(`tok_${userId}`, userId, deviceId, hash, now)
    .run();
  return raw;
}
