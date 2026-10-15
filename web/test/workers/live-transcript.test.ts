import { applyD1Migrations } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbSchema from '../../src/db/schema';
import { liveTranscriptStream } from '../../src/server/live-transcript';
import { CURSOR_OVERLAP_MS } from '../../src/server/transcript-delta';
import { Route as transcriptRoute } from '../../src/routes/api/meetings/$id/transcript';
import { handler, insertMeeting, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_live' as string | null }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
}));

const MEETING = 'meet_live';
const db = drizzle(testEnv.DB, { schema: dbSchema });
const get = handler(transcriptRoute, 'GET');

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_live';
  await resetTables('transcript_segments', 'meeting_segments', 'summaries', 'meetings', 'users');
  await insertUser('user_live');
  await insertUser('user_other');
  await insertMeeting({ id: MEETING, userId: 'user_live', status: 'recording' });
});

/** A segment whose transcript was written at `transcribedAt`, with its lines. */
async function transcribed(idx: number, transcribedAt: number, lines: [number, string][]) {
  await testEnv.DB.prepare(
    `INSERT INTO meeting_segments
      (id, meeting_id, idx, r2_key, bytes, offset_ms, duration_ms, transcribe_status, transcribed_at, created_at)
     VALUES (?, ?, ?, 'k', 3, ?, 60000, 'complete', ?, 0)`,
  )
    .bind(`seg_${idx}`, MEETING, idx, idx * 60_000, transcribedAt)
    .run();
  for (const [startMs, text] of lines) {
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(`line_${startMs}`, MEETING, startMs, startMs + 1_000, text)
      .run();
  }
}

async function delta(since: number) {
  const response = await get({
    request: new Request(`https://eavesy.test/api/meetings/${MEETING}/transcript?since=${since}`),
    params: { id: MEETING },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    status: string;
    cursor: number;
    ranges: { fromMs: number; toMs: number }[];
    lines: { id: string; text: string }[];
  };
}

describe('transcript since a cursor', () => {
  it('returns only the ranges transcribed after the cursor, with every line in them', async () => {
    const t0 = 1_000_000;
    await transcribed(0, t0, [[1_000, 'Morning all.']]);
    await transcribed(1, t0 + 60_000, [[61_000, 'First item is the launch.']]);

    const all = await delta(0);
    expect(all.cursor).toBe(t0 + 60_000);
    expect(all.lines.map((line) => line.text)).toEqual(['Morning all.', 'First item is the launch.']);
    expect(all.status).toBe('recording');

    const fresh = await delta(t0 + CURSOR_OVERLAP_MS + 1);
    expect(fresh.ranges).toEqual([{ fromMs: 57_000, toMs: 123_000 }]);
    expect(fresh.lines.map((line) => line.text)).toEqual(['First item is the launch.']);

    const none = await delta(t0 + 60_000 + CURSOR_OVERLAP_MS);
    expect(none).toMatchObject({ cursor: t0 + 60_000 + CURSOR_OVERLAP_MS, ranges: [], lines: [] });
  });

  it('a range whose echo was removed comes back without it', async () => {
    await transcribed(0, 5_000_000, [[1_000, 'Kept.']]);
    await testEnv.DB.prepare(`DELETE FROM transcript_segments WHERE id = 'line_1000'`).run();
    const result = await delta(0);
    expect(result.ranges).toHaveLength(1);
    expect(result.lines).toEqual([]);
  });

  it('is not available to another user', async () => {
    actor.userId = 'user_other';
    const response = await get({
      request: new Request(`https://eavesy.test/api/meetings/${MEETING}/transcript`),
      params: { id: MEETING },
    });
    expect(response.status).toBe(404);
  });

  it('streams as server-sent events when asked', async () => {
    const response = await get({
      request: new Request(`https://eavesy.test/api/meetings/${MEETING}/transcript`, {
        headers: { accept: 'text/event-stream' },
      }),
      params: { id: MEETING },
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    await response.body?.cancel();
  });
});

describe('live transcript stream', () => {
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string) {
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    return text;
  }

  it('pushes new lines with their cursor, then says when the meeting is done', async () => {
    const response = liveTranscriptStream(db, MEETING, 0, { pollMs: 5, keepAliveMs: 60_000 });
    const reader = response.body!.getReader();
    expect(await readUntil(reader, 'retry:')).toContain('retry: 5');

    await transcribed(0, 7_000_000, [[2_000, 'Can everyone hear me?']]);
    const lines = await readUntil(reader, 'event: lines');
    expect(lines).toContain('id: 7000000\nevent: lines');
    expect(lines).toContain('Can everyone hear me?');

    await testEnv.DB.prepare(`UPDATE meetings SET status = 'complete' WHERE id = ?`).bind(MEETING).run();
    const end = await readUntil(reader, 'event: done');
    expect(end).toContain('event: status');
    expect(end).toContain('"status":"complete"');
    expect((await reader.read()).done).toBe(true);
  });

  it('sends nothing already covered by the cursor it resumed from', async () => {
    await transcribed(0, 7_000_000, [[2_000, 'Old line.']]);
    await testEnv.DB.prepare(`UPDATE meetings SET status = 'failed' WHERE id = ?`).bind(MEETING).run();
    const response = liveTranscriptStream(db, MEETING, 7_000_000 + CURSOR_OVERLAP_MS, { pollMs: 5 });
    const text = await new Response(response.body).text();
    expect(text).not.toContain('event: lines');
    expect(text).toContain('event: done');
  });

  it('ends after its lifetime so the client reconnects', async () => {
    const response = liveTranscriptStream(db, MEETING, 0, { pollMs: 5, lifetimeMs: 20, keepAliveMs: 60_000 });
    const text = await new Response(response.body).text();
    expect(text).not.toContain('event: done');
  });
});
