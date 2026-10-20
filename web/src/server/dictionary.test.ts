import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { dictionaryRequest } from './dictionary';
import { createFakeEnv } from './testing/fake-env';
import * as dictionary from '@/db/repo/dictionary';

function setup() {
  const fake = createFakeEnv();
  fake.sqlite.run("INSERT INTO users (id, created_at, updated_at) VALUES ('u1', 1, 1), ('u2', 1, 1)");
  fake.sqlite.run("INSERT INTO dictations (id, user_id, title, transcript, cleaned_text, duration_sec, created_at) VALUES ('d1', 'u1', 'Memo', 'Open a pool request today.', 'Open a pool request today.', 5, 1)");
  const db = drizzle(fake.env.DB, { schema });
  const request = (method: string, body: unknown, userId = 'u1', deviceId?: string) => dictionaryRequest(new Request('https://test/api/dictionary', {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), db, { userId, deviceId, isAnonymous: false });
  return { ...fake, db, request };
}

describe('dictionary feedback API and persistence', () => {
  test('saves actual user edits, preserves raw speech, reloads dictionary and forgets', async () => {
    const t = setup();
    const result = await t.request('POST', { dictationId: 'd1', original: 'Open a pool request today.', corrected: 'Open a pull request today.' });
    expect(await result.json()).toEqual({ learned: 1 });
    expect(t.sqlite.query('SELECT transcript, cleaned_text FROM dictations').get()).toEqual({ transcript: 'Open a pool request today.', cleaned_text: 'Open a pull request today.' });
    const entries = await dictionary.list(t.db, 'u1');
    expect(entries).toMatchObject([{ from: 'pool', to: 'pull' }]);
    await t.request('DELETE', { id: entries[0].id }, 'u2');
    expect(await dictionary.list(t.db, 'u1')).toHaveLength(1);
    expect(await dictionary.list(t.db, 'u2')).toHaveLength(0);
    await t.request('DELETE', { id: entries[0].id });
    expect(await dictionary.list(t.db, 'u1')).toHaveLength(0);
  });
  test('rejects another account, stale originals, malformed bodies, and unreferenced browser text', async () => {
    const body = { dictationId: 'd1', original: 'Open a pool request today.', corrected: 'Open a pull request today.' };
    const t = setup();
    expect((await t.request('POST', body, 'u2')).status).toBe(404);
    expect((await t.request('POST', { ...body, original: 'stale' })).status).toBe(409);
    expect((await t.request('POST', { original: body.original, corrected: body.corrected })).status).toBe(400);
    expect((await t.request('POST', { original: '' })).status).toBe(400);
    expect(await dictionary.list(t.db, 'u1')).toHaveLength(0);
  });
  test('paired desktop edits learn idempotently and manual corrections replace mistaken learning', async () => {
    const t = setup();
    const body = { original: 'Ask repack a fi about shipping.', corrected: 'Ask Repackify about shipping.' };
    await t.request('POST', body, 'u1', 'mac1');
    await t.request('POST', body, 'u1', 'mac1');
    expect(await dictionary.list(t.db, 'u1')).toHaveLength(1);
    await t.request('PUT', { from: 'repack a fi', to: 'Repackify Inc' });
    expect(await dictionary.list(t.db, 'u1')).toMatchObject([{ to: 'Repackify Inc' }]);
  });
});

test('meeting transcript edits learn from human changes and preserve raw speech', async () => {
  const t = setup();
  const { editSegment } = await import('@/db/repo/transcripts');
  t.sqlite.run("INSERT INTO meetings (id,user_id,title,started_at,source,status,created_at,updated_at) VALUES ('m1','u1','Memo',1,'desktop','complete',1,1)");
  t.sqlite.run("INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES ('s1','m1',0,2000,'Open a pool request today.')");
  await editSegment(t.db, { userId: 'u2', meetingId: 'm1', segmentId: 's1', text: 'Open a fake request today.' });
  expect(await dictionary.list(t.db, 'u2')).toHaveLength(0);
  await editSegment(t.db, { userId: 'u1', meetingId: 'm1', segmentId: 's1', text: 'Open a pull request today.' });
  expect(await dictionary.list(t.db, 'u1')).toMatchObject([{ from: 'pool', to: 'pull' }]);
  expect(t.sqlite.query("SELECT text,raw_text,is_edited FROM transcript_segments WHERE id='s1'").get())
    .toEqual({ text: 'Open a pull request today.', raw_text: 'Open a pool request today.', is_edited: 1 });
});

test('concurrent corrections respect capacity while existing entries stay editable', async () => {
  const t = setup();
  t.sqlite.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<499)
    INSERT INTO personal_dictionary(id,user_id,source_key,from_text,to_text,created_at,updated_at)
    SELECT 'word_'||i,'u1','source_'||i,'source_'||i,'target_'||i,1,1 FROM n`);
  const results = await Promise.all([
    dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha' }]),
    dictionary.remember(t.db, 'u1', [{ from: 'misheard beta', to: 'Beta' }]),
  ]);
  expect(results.reduce((a, b) => a+b, 0)).toBe(1);
  expect(await dictionary.list(t.db, 'u1')).toHaveLength(500);
  expect(await dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha revised' }])).toBe(1);
  expect(await dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha revised' }])).toBe(0);
});
