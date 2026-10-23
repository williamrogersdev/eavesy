/// <reference types="vite/client" />
import { applyD1Migrations } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { handleEmbedMeeting } from '../../src/server/processing/embed';
import { REFRESH_DELAY_SECONDS } from '../../src/server/agent-transcript-refresh';
import { Route as LineRoute } from '../../src/routes/api/meetings/$id/lines/$lineId';
import { Route as MeetingRoute } from '../../src/routes/api/meetings/$id';
import { handler, insertMeeting, insertUser, resetTables, row, runtimeEnv, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
const queued = vi.hoisted(() => ({ messages: [] as { message: { kind: string; meetingId?: string; queuedAt?: number }; delaySeconds?: number }[] }));
vi.mock('../../src/server/queue', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: async (message: { kind: string; meetingId?: string; queuedAt?: number }, opts?: { delaySeconds?: number }) => {
    queued.messages.push({ message, delaySeconds: opts?.delaySeconds });
  },
}));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));
// waitUntil is a no-op outside a request; run the refresh inline instead.
vi.mock('cloudflare:workers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
}));
const pending = vi.hoisted(() => [] as Promise<unknown>[]);

const USER = 'user_edits';
const call = (route: { options: unknown }, method: string, url: string, body?: unknown, params: Record<string, string> = {}) =>
  handler(route, method)({
    request: new Request(`https://eavesy.test${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  });

async function settled() {
  await Promise.all(pending.splice(0));
}

async function addLine(meetingId: string, id: string, text: string, speakerId = 'you') {
  await testEnv.DB.prepare(
    `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text, speaker_id, is_final, is_edited)
     VALUES (?, ?, 0, 1000, ?, ?, 1, 0)`,
  ).bind(id, meetingId, text, speakerId).run();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('embeddings', 'transcript_segments', 'meetings', 'users');
  await insertUser(USER);
  actor.userId = USER;
  queued.messages.length = 0;
  pending.length = 0;
});

describe('transcript edits keep the search index current', () => {
  it('a line edit queues a delayed re-embed next to the agent transcript rebuild', async () => {
    await insertMeeting({ id: 'meet_edit', userId: USER, status: 'complete' });
    await addLine('meet_edit', 'line_1', 'Ship it on friday');
    const before = Date.now();
    const response = await call(LineRoute, 'PATCH', '/api/meetings/meet_edit/lines/line_1', { text: 'Ship it on Friday' }, { id: 'meet_edit', lineId: 'line_1' });
    expect(response.status).toBe(200);
    await settled();
    expect(queued.messages).toEqual([
      { message: { kind: 'agent-transcript', meetingId: 'meet_edit', onlyIfMissing: true }, delaySeconds: REFRESH_DELAY_SECONDS },
      { message: { kind: 'embed', meetingId: 'meet_edit', queuedAt: expect.any(Number) }, delaySeconds: REFRESH_DELAY_SECONDS },
    ]);
    expect(queued.messages[1].message.queuedAt).toBeGreaterThanOrEqual(before);
  });

  it('renaming a speaker re-embeds, since the embedded text carries the names; a folder move does not', async () => {
    await insertMeeting({ id: 'meet_names', userId: USER, status: 'complete' });
    await addLine('meet_names', 'line_1', 'Hello');
    expect((await call(MeetingRoute, 'PATCH', '/api/meetings/meet_names', { speakerNames: { you: 'Ada' } }, { id: 'meet_names' })).status).toBe(200);
    await settled();
    expect(queued.messages.map((q) => q.message.kind)).toEqual(['agent-transcript', 'embed']);

    queued.messages.length = 0;
    expect((await call(MeetingRoute, 'PATCH', '/api/meetings/meet_names', { folderId: null }, { id: 'meet_names' })).status).toBe(200);
    await settled();
    expect(queued.messages.map((q) => q.message.kind)).toEqual(['agent-transcript']);
  });

  it('an edit on a meeting that is not complete queues nothing', async () => {
    await insertMeeting({ id: 'meet_live', userId: USER, status: 'processing' });
    await addLine('meet_live', 'line_1', 'Hello');
    expect((await call(LineRoute, 'DELETE', '/api/meetings/meet_live/lines/line_1', undefined, { id: 'meet_live', lineId: 'line_1' })).status).toBe(200);
    await settled();
    expect(queued.messages).toEqual([]);
  });
});

describe('a burst of edits embeds once', () => {
  function env() {
    const vectorize = { deleteByIds: vi.fn(async () => undefined), upsert: vi.fn(async () => undefined) };
    const ai = { run: vi.fn(async (_model: string, input: unknown) => ({ data: (input as { text: string[] }).text.map(() => new Array(1024).fill(0.1)) })) };
    const base = runtimeEnv(undefined, ai);
    return { ...base, VECTORIZE: vectorize as unknown as typeof base.VECTORIZE, ai, vectorize };
  }

  it('skips a re-index queued before the meeting was last embedded, and runs one queued after', async () => {
    await insertMeeting({ id: 'meet_burst', userId: USER, status: 'complete' });
    await addLine('meet_burst', 'line_1', 'Some words to embed');
    const db = drizzle(testEnv.DB, { schema });
    const e = env();

    // The pipeline's own embed (no queuedAt) always runs.
    await handleEmbedMeeting('meet_burst', db, e);
    expect(e.ai.run).toHaveBeenCalledTimes(1);
    const embeddedAt = (await row<{ at: number }>('SELECT max(created_at) AS at FROM embeddings WHERE source_id = ?', 'meet_burst'))!.at;

    // Two edits from before that run each queued a re-index: both are moot now.
    await handleEmbedMeeting('meet_burst', db, e, { queuedAt: embeddedAt - 10 });
    await handleEmbedMeeting('meet_burst', db, e, { queuedAt: embeddedAt });
    expect(e.ai.run).toHaveBeenCalledTimes(1);

    // An edit after it needs a fresh pass.
    await handleEmbedMeeting('meet_burst', db, e, { queuedAt: embeddedAt + 1 });
    expect(e.ai.run).toHaveBeenCalledTimes(2);
    expect(e.vectorize.deleteByIds).toHaveBeenCalledTimes(1);
    expect(e.vectorize.upsert).toHaveBeenCalledTimes(2);
  });
});
