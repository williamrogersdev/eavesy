import { describe, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
import { createFakeEnv } from '@/server/testing/fake-env';
import { claimTranscript, create, get, TRANSCRIPT_CLAIM_TTL_MS } from './captures';

async function setup() {
  const fake = createFakeEnv();
  const db = drizzle(fake.env.DB, { schema });
  const now = Date.now();
  fake.sqlite.run(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'owner@example.com', ?, ?)`, [now, now]);
  const id = await create(db, {
    userId: 'u1',
    kind: 'video',
    captureMode: 'screen',
    title: 'Screen recording',
    r2Key: 'cap/1',
    contentType: 'video/webm',
    bytes: 3,
  });
  const claim = (to: 'processing' | 'failed', error?: string) =>
    claimTranscript(db, { captureId: id, userId: 'u1', from: 'none', to, staleAfterMs: TRANSCRIPT_CLAIM_TTL_MS, error });
  const age = (ms: number) => fake.sqlite.run(`UPDATE captures SET updated_at = ? WHERE id = ?`, [Date.now() - ms, id]);
  const row = async () => (await get(db, { captureId: id, userId: 'u1' }))!;
  return { claim, age, row, fake, id };
}

describe('claiming a capture transcript', () => {
  test('a second upload is refused while the first is transcribing, and takes over once that is stale', async () => {
    const t = await setup();
    expect(await t.claim('processing')).toBe(true);
    expect(await t.claim('processing')).toBe(false);
    t.age(TRANSCRIPT_CLAIM_TTL_MS + 1);
    expect(await t.claim('processing')).toBe(true);
    expect((await t.row()).transcriptStatus).toBe('processing');
  });

  test('a transcript that finished is never claimed again, however old', async () => {
    const t = await setup();
    t.fake.sqlite.run(`UPDATE captures SET transcript_status = 'complete', transcript = 'hello' WHERE id = ?`, [t.id]);
    t.age(TRANSCRIPT_CLAIM_TTL_MS * 10);
    expect(await t.claim('processing')).toBe(false);
    expect((await t.row()).transcript).toBe('hello');
  });

  test('giving up on a transcript records why, so the capture page can say so', async () => {
    const t = await setup();
    expect(await t.claim('failed', 'The audio track is too large to transcribe (50 MB max).')).toBe(true);
    const row = await t.row();
    expect(row.transcriptStatus).toBe('failed');
    expect(row.transcriptError).toContain('too large');
  });
});
