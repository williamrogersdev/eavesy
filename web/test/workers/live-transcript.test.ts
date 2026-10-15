import { applyD1Migrations } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbSchema from '../../src/db/schema';
import { liveTranscriptStream } from '../../src/server/live-transcript';
import { CURSOR_OVERLAP_MS } from '../../src/server/transcript-delta';
import { Route as transcriptRoute } from '../../src/routes/api/meetings/$id/transcript';
import { Route as sessionTranscriptRoute } from '../../src/routes/api/sessions/$id/transcript';
import { handler, insertMeeting, insertUser, resetTables, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_live' as string | null }));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
}));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
}));

const MEETING = 'meet_live';
const db = drizzle(testEnv.DB, { schema: dbSchema });
const get = handler(transcriptRoute, 'GET');
const getForDevice = handler(sessionTranscriptRoute, 'GET');

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = 'user_live';
  await resetTables('transcript_segments', 'meeting_segments', 'summaries', 'meetings', 'users', 'rate_limits');
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

  it('polling an idle meeting at its cursor sends nothing, even inside the overlap', async () => {
    await transcribed(0, 2_000_000, [[1_000, 'Only line.']]);
    const first = await delta(0);
    expect(first.lines).toHaveLength(1);
    const again = await delta(first.cursor);
    expect(again).toMatchObject({ cursor: first.cursor, ranges: [], lines: [] });
  });

  it('a segment stamped behind the cursor comes along with the next new one', async () => {
    await transcribed(0, 3_000_000, [[1_000, 'First.']]);
    const first = await delta(0);
    await transcribed(1, 3_000_000 - 5_000, [[61_000, 'Late stamp.']]);
    expect((await delta(first.cursor)).lines).toEqual([]);
    await transcribed(2, 3_000_000 + 60_000, [[121_000, 'Next.']]);
    const next = await delta(first.cursor);
    expect(next.lines.map((line) => line.text)).toEqual(['First.', 'Late stamp.', 'Next.']);
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

  it('limits how often one user can poll or reconnect', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const response = await get({
        request: new Request(`https://eavesy.test/api/meetings/${MEETING}/transcript?since=0`),
        params: { id: MEETING },
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
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

describe('transcript since a cursor, for the desktop app', () => {
  it('answers with the same delta as the web route', async () => {
    await transcribed(0, 1_000, [[0, 'Before.']]);
    await transcribed(1, 100_000, [[60_500, 'After.']]);
    const response = await getForDevice({
      request: new Request(`https://eavesy.test/api/sessions/${MEETING}/transcript?since=50000`),
      params: { id: MEETING },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cursor: number; lines: { text: string }[] };
    expect(body.cursor).toBe(100_000);
    expect(body.lines.map((line) => line.text)).toEqual(['After.']);
    expect(body).toEqual(await delta(50_000));
  });

  it('is not available to another user', async () => {
    actor.userId = 'user_other';
    const response = await getForDevice({
      request: new Request(`https://eavesy.test/api/sessions/${MEETING}/transcript?since=0`),
      params: { id: MEETING },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'meeting_not_found' });
  });

  it('says a deleted meeting is gone, distinctly from a missing route', async () => {
    await testEnv.DB.prepare(`UPDATE meetings SET deleted_at = 1 WHERE id = ?`).bind(MEETING).run();
    const response = await getForDevice({
      request: new Request(`https://eavesy.test/api/sessions/${MEETING}/transcript?since=0`),
      params: { id: MEETING },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'meeting_not_found' });
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

  it('sends each segment once, including one stamped behind the cursor', async () => {
    const response = liveTranscriptStream(db, MEETING, 0, { pollMs: 2, keepAliveMs: 60_000, lifetimeMs: 400 });
    const text = new Response(response.body).text();
    await transcribed(0, 8_000_000, [[2_000, 'One.']]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await transcribed(1, 8_000_000 - 10_000, [[62_000, 'Two, stamped late.']]);
    const body = await text;
    const events = body.split('\n\n').filter((chunk) => chunk.includes('event: lines'));
    expect(events).toHaveLength(2);
    expect(events[0]).toContain('One.');
    expect(events[1]).toContain('Two, stamped late.');
    expect(events[1]).not.toContain('"text":"One."');
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
