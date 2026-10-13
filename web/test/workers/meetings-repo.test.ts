import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it } from 'vitest';
import * as meetingsRepo from '../../src/db/repo/meetings';
import * as dbSchema from '../../src/db/schema';
import { timeD1, withRequestTiming } from '../../src/server/perf';

interface TestEnv {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;
const db = drizzle(timeD1(testEnv.DB), { schema: dbSchema });

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  const now = Date.now();
  const stmts = [];
  for (const user of ['owner', 'other']) {
    stmts.push(
      testEnv.DB.prepare(
        `INSERT INTO users (id, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
         VALUES (?, 'whisper', 'en', 0, ?, ?)`,
      ).bind(user, now, now),
    );
  }
  stmts.push(
    testEnv.DB.prepare(
      `INSERT INTO meetings (id, user_id, title, description, started_at, source, language, status,
         summary_override_md, expires_at, created_at, updated_at)
       VALUES ('m1', 'owner', 'Standup', 'daily', ?, 'desktop', 'en', 'complete', '# long edited summary', ?, ?, ?)`,
    ).bind(now, now + 1e9, now, now),
    testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text) VALUES
         ('s2', 'm1', 2000, 3000, 'second'), ('s1', 'm1', 0, 1000, 'first')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO summaries (id, meeting_id, tldr, topics_json, generated_by_model, generated_at)
       VALUES ('sum1', 'm1', 'All good', '["ops"]', 'test', ?)`,
    ).bind(now),
  );
  await testEnv.DB.batch(stmts);
});

describe('meetings repo', () => {
  it('getFull loads meeting, summary and ordered segments in one round trip', async () => {
    let full: Awaited<ReturnType<typeof meetingsRepo.getFull>> = null;
    const response = await withRequestTiming(new Request('https://x.test/api/meetings/m1'), async () => {
      full = await meetingsRepo.getFull(db, { meetingId: 'm1', userId: 'owner' });
      return new Response('ok');
    });
    expect(full).not.toBeNull();
    expect(full!.meeting.title).toBe('Standup');
    expect(full!.summary?.tldr).toBe('All good');
    expect(full!.summary?.topics).toEqual(['ops']);
    expect(full!.segments.map((s) => s.text)).toEqual(['first', 'second']);
    expect(response.headers.get('Server-Timing')).toContain('1 queries, 1 sequential');
  });

  it("getFull returns nothing for someone else's meeting", async () => {
    expect(await meetingsRepo.getFull(db, { meetingId: 'm1', userId: 'other' })).toBeNull();
    expect(await meetingsRepo.getFull(db, { meetingId: 'missing', userId: 'owner' })).toBeNull();
  });

  it('listSummariesForUser leaves out the edited markdown', async () => {
    const rows = await meetingsRepo.listSummariesForUser(db, { userId: 'owner' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'm1', title: 'Standup', description: 'daily', status: 'complete' });
    expect(rows[0]).not.toHaveProperty('summaryOverrideMd');
    expect(await meetingsRepo.listSummariesForUser(db, { userId: 'other' })).toEqual([]);
  });
});
