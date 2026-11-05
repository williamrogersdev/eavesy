import { describe, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
import { createFakeEnv } from '@/server/testing/fake-env';
import { claimTranscript, create, get, listNoteChanges, replaceNote, setTranscript, TRANSCRIPT_CLAIM_TTL_MS } from './captures';

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
  return { db, claim, age, row, fake, id };
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

  test('a result that outlived its claim does not overwrite the one that won', async () => {
    const t = await setup();
    expect(await t.claim('processing')).toBe(true);
    t.age(TRANSCRIPT_CLAIM_TTL_MS + 1);
    expect(await t.claim('processing')).toBe(true);
    const write = (transcript: string) =>
      setTranscript(t.db, { captureId: t.id, userId: 'u1', status: 'complete', transcript, ifStatus: 'processing' });
    expect(await write('second upload')).toBe(true);
    expect(await write('first upload, late')).toBe(false);
    expect((await t.row()).transcript).toBe('second upload');
  });

  test('giving up on a transcript records why, so the capture page can say so', async () => {
    const t = await setup();
    expect(await t.claim('failed', 'The audio track is too large to transcribe (50 MB max).')).toBe(true);
    const row = await t.row();
    expect(row.transcriptStatus).toBe('failed');
    expect(row.transcriptError).toContain('too large');
  });
});

describe('note edits shared between Macs', () => {
  async function notes() {
    const fake = createFakeEnv();
    const db = drizzle(fake.env.DB, { schema });
    const now = Date.now();
    fake.sqlite.run(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u1', 'owner@example.com', ?, ?)`, [now, now]);
    fake.sqlite.run(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'other@example.com', ?, ?)`, [now, now]);
    const note = (userId: string, clientCaptureId: string, kind: 'note' | 'image' = 'note') =>
      create(db, {
        userId,
        kind,
        captureMode: kind === 'note' ? 'note' : 'screenshot',
        source: 'desktop',
        title: 'Note',
        r2Key: `cap/${clientCaptureId}`,
        contentType: kind === 'note' ? 'text/markdown' : 'image/png',
        bytes: 5,
        transcript: 'first',
        clientCaptureId,
      });
    const at = (id: string, ms: number) => fake.sqlite.run(`UPDATE captures SET updated_at = ? WHERE id = ?`, [ms, id]);
    return { db, fake, note, at };
  }

  test('changes come oldest first, only notes of this user, and the cursor breaks ties by id', async () => {
    const t = await notes();
    const a = await t.note('u1', '00000000-0000-4000-8000-00000000000a');
    const b = await t.note('u1', '00000000-0000-4000-8000-00000000000b');
    const later = await t.note('u1', '00000000-0000-4000-8000-00000000000c');
    const image = await t.note('u1', '00000000-0000-4000-8000-00000000000d', 'image');
    const someoneElse = await t.note('u2', '00000000-0000-4000-8000-00000000000e');
    for (const id of [a, b, image, someoneElse]) t.at(id, 1_000);
    t.at(later, 2_000);
    const [first, second] = [a, b].sort();

    const all = await listNoteChanges(t.db, { userId: 'u1', since: 0, afterId: '', limit: 10 });
    expect(all.map((row) => row.id)).toEqual([first, second, later]);

    const page = await listNoteChanges(t.db, { userId: 'u1', since: 1_000, afterId: first, limit: 10 });
    expect(page.map((row) => row.id)).toEqual([second, later]);
    expect(await listNoteChanges(t.db, { userId: 'u1', since: 2_000, afterId: later, limit: 10 })).toEqual([]);
  });

  test('replacing a note changes its text and change time, and never touches another user or a deleted note', async () => {
    const t = await notes();
    const id = await t.note('u1', '00000000-0000-4000-8000-00000000000a');
    t.at(id, 1_000);
    expect(await replaceNote(t.db, { captureId: id, userId: 'u2', text: 'stolen', bytes: 6 })).toBeNull();

    const updatedAt = await replaceNote(t.db, { captureId: id, userId: 'u1', text: 'second', bytes: 6, title: 'Renamed' });
    expect(updatedAt).toBeGreaterThan(1_000);
    const row = (await get(t.db, { captureId: id, userId: 'u1' }))!;
    expect([row.transcript, row.bytes, row.title, row.updatedAt]).toEqual(['second', 6, 'Renamed', updatedAt!]);
    const [change] = await listNoteChanges(t.db, { userId: 'u1', since: 1_000, afterId: '', limit: 10 });
    expect(change.updatedAt).toBe(updatedAt!);

    t.fake.sqlite.run(`UPDATE captures SET deleted_at = ? WHERE id = ?`, [Date.now(), id]);
    expect(await replaceNote(t.db, { captureId: id, userId: 'u1', text: 'third', bytes: 5 })).toBeNull();
    expect(await listNoteChanges(t.db, { userId: 'u1', since: 0, afterId: '', limit: 10 })).toEqual([]);
  });
});
