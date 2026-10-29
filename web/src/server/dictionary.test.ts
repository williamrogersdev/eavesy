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
  fake.sqlite.run("INSERT INTO dictations (id, user_id, title, transcript, cleaned_text, duration_sec, created_at) VALUES ('d2', 'u1', 'Memo', 'Ship it to gay lord boxes today.', 'Ship it to gay lord boxes today.', 5, 1)");
  const db = drizzle(fake.env.DB, { schema });
  const request = (method: string, body: unknown, userId = 'u1', deviceId?: string) => dictionaryRequest(new Request('https://test/api/dictionary', {
    method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), db, { userId, deviceId, isAnonymous: false });
  return { ...fake, db, request };
}

describe('dictionary feedback API and persistence', () => {
  test('saves actual user edits, preserves raw speech, reloads dictionary and forgets', async () => {
    const t = setup();
    const body = { dictationId: 'd2', original: 'Ship it to gay lord boxes today.', corrected: 'Ship it to Gaylord Boxes today.' };
    const result = await t.request('POST', body);
    expect(await result.json()).toEqual({ learned: 1, words: [{ from: 'gay lord boxes', to: 'Gaylord Boxes', pending: true }] });
    const retry = await t.request('POST', body);
    expect(await retry.json()).toEqual({ learned: 0, words: [] });
    expect(t.sqlite.query("SELECT transcript, cleaned_text FROM dictations WHERE id = 'd2'").get()).toEqual({ transcript: 'Ship it to gay lord boxes today.', cleaned_text: 'Ship it to Gaylord Boxes today.' });
    const entries = await dictionary.list(t.db, 'u1');
    expect(entries).toMatchObject([{ from: 'gay lord boxes', to: 'Gaylord Boxes', origin: 'learned' }]);
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
    expect(await dictionary.list(t.db, 'u1')).toMatchObject([{ origin: 'learned' }]);
    await t.request('PUT', { from: 'repack a fi', to: 'Repackify Inc' });
    expect(await dictionary.list(t.db, 'u1')).toMatchObject([{ to: 'Repackify Inc', origin: 'manual' }]);
  });
  test('ordinary words learned from edits stay listed but never steer transcription', async () => {
    const t = setup();
    expect(await (await t.request('POST', { dictationId: 'd1', original: 'Open a pool request today.', corrected: 'Open a pull request today.' })).json())
      .toEqual({ learned: 0, words: [] });
    t.sqlite.run(`INSERT INTO personal_dictionary (id, user_id, source_key, from_text, to_text, seen, created_at, updated_at) VALUES
      ('w1', 'u1', 'keep', 'keep', 'kept', 2, 1, 1), ('w2', 'u1', 'yvesy', 'Yvesy', 'Eavesy', 2, 1, 2)`);
    await t.request('PUT', { from: 'fall', to: 'full' });
    expect((await dictionary.list(t.db, 'u1')).map(e => e.to).sort()).toEqual(['Eavesy', 'full', 'kept']);
    expect((await dictionary.listForTranscription(t.db, 'u1')).map(e => e.to).sort()).toEqual(['Eavesy', 'full']);
  });
  test('a word added by hand stays manual when an edit relearns it, and legacy rows take the new origin', async () => {
    const t = setup();
    t.sqlite.run(`INSERT INTO personal_dictionary (id, user_id, source_key, from_text, to_text, created_at, updated_at) VALUES
      ('w1', 'u1', 'yvesy', 'Yvesy', 'Eavesy', 1, 1), ('w2', 'u1', 'curry', 'curry', 'Curry', 1, 1)`);
    await dictionary.remember(t.db, 'u1', [{ from: 'Yvesy', to: 'Eavesi' }], 'learned');
    await dictionary.remember(t.db, 'u1', [{ from: 'curry', to: 'Currie' }], 'manual');
    await dictionary.remember(t.db, 'u1', [{ from: 'curry', to: 'Curie' }], 'learned');
    const origins = Object.fromEntries((await dictionary.list(t.db, 'u1')).map(e => [e.sourceKey, e.origin]));
    expect(origins).toEqual({ yvesy: 'learned', curry: 'manual' });
  });
});

test('a fix made once is a suggestion until it is made again or kept, and reversing it forgets it', async () => {
  const t = setup();
  const steering = async () => (await dictionary.listForTranscription(t.db, 'u1')).map(e => `${e.from}>${e.to}`).sort();
  expect(await dictionary.rememberCorrections(t.db, 'u1', [{ from: 'SEO', to: 'SEU' }, { from: 'cube cuddle', to: 'Kubectl' }], 'learned'))
    .toEqual([{ from: 'SEO', to: 'SEU', pending: true }, { from: 'cube cuddle', to: 'Kubectl', pending: true }]);
  expect(await steering()).toEqual([]);
  // Changing it straight back drops the mistaken one instead of keeping both directions.
  await dictionary.rememberCorrections(t.db, 'u1', [{ from: 'SEU', to: 'SEO' }], 'learned');
  expect((await dictionary.list(t.db, 'u1')).map(e => e.from).sort()).toEqual(['SEU', 'cube cuddle']);
  // An immediate retry of one edit is not a second sighting; a later one is.
  expect(await dictionary.rememberCorrections(t.db, 'u1', [{ from: 'cube cuddle', to: 'Kubectl' }], 'learned')).toEqual([]);
  t.sqlite.run("UPDATE personal_dictionary SET updated_at = 1");
  expect(await dictionary.rememberCorrections(t.db, 'u1', [{ from: 'cube cuddle', to: 'Kubectl' }], 'learned'))
    .toEqual([{ from: 'cube cuddle', to: 'Kubectl', pending: false }]);
  expect(await steering()).toEqual(['cube cuddle>Kubectl']);
  // Keeping a suggestion by hand confirms it at once.
  expect(await (await t.request('PUT', { from: 'SEU', to: 'SEO' })).json()).toMatchObject({ learned: 1, status: 'saved' });
  expect(await steering()).toEqual(['SEU>SEO', 'cube cuddle>Kubectl']);
});

test('a fix to a different word restarts the count, and rows from before the count are suggestions', async () => {
  const t = setup();
  const learn = async (to: string) => {
    t.sqlite.run("UPDATE personal_dictionary SET updated_at = 1");
    return dictionary.rememberCorrections(t.db, 'u1', [{ from: 'cube cuddle', to }], 'learned');
  };
  expect(await learn('Kubectl')).toEqual([{ from: 'cube cuddle', to: 'Kubectl', pending: true }]);
  expect(await learn('KubeCTL')).toEqual([{ from: 'cube cuddle', to: 'KubeCTL', pending: true }]);
  expect(await learn('Kubectl')).toEqual([{ from: 'cube cuddle', to: 'Kubectl', pending: true }]);
  expect(await learn('Kubectl')).toEqual([{ from: 'cube cuddle', to: 'Kubectl', pending: false }]);
  t.sqlite.run(`INSERT INTO personal_dictionary (id, user_id, source_key, from_text, to_text, origin, created_at, updated_at) VALUES
    ('w9', 'u1', 'yvesy', 'Yvesy', 'Eavesy', 'learned', 1, 1)`);
  expect((await dictionary.listForTranscription(t.db, 'u1')).map(e => e.to)).toEqual(['Kubectl']);
});

test('a bulk paste adds every valid replacement and counts the rest as skipped', async () => {
  const t = setup();
  const result = await t.request('PUT', { entries: [
    { from: 'easy', to: 'Eavesy' },
    { from: 'cube cuddle', to: 'kubectl' },
    { from: 'same', to: 'same' },
  ] });
  expect(await result.json()).toEqual({ learned: 2, skipped: 1, status: 'saved' });
  expect((await dictionary.list(t.db, 'u1')).map(e => e.to).sort()).toEqual(['Eavesy', 'kubectl']);
  const again = await t.request('PUT', { entries: [{ from: 'easy', to: 'Eavesy' }] });
  expect(await again.json()).toEqual({ learned: 0, skipped: 0, status: 'unchanged' });
  expect((await t.request('PUT', { entries: [] })).status).toBe(400);
});

test('a bulk paste stops at the 500-entry cap', async () => {
  const t = setup();
  for (let i = 0; i < 499; i++) t.sqlite.run(`INSERT INTO personal_dictionary (id, user_id, source_key, from_text, to_text, created_at, updated_at) VALUES ('w${i}', 'u1', 'heard${i}', 'heard${i}', 'Typed${i}', 1, 1)`);
  const result = await t.request('PUT', { entries: [{ from: 'easy', to: 'Eavesy' }, { from: 'cube cuddle', to: 'kubectl' }] });
  expect((await result.json()).learned).toBe(1);
  expect(await dictionary.list(t.db, 'u1')).toHaveLength(500);
});

test('meeting transcript edits learn from human changes and preserve raw speech', async () => {
  const t = setup();
  const { editSegment } = await import('@/db/repo/transcripts');
  t.sqlite.run("INSERT INTO meetings (id,user_id,title,started_at,source,status,created_at,updated_at) VALUES ('m1','u1','Memo',1,'desktop','complete',1,1)");
  t.sqlite.run("INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES ('s1','m1',0,2000,'Open a pool request today.')");
  await editSegment(t.db, { userId: 'u2', meetingId: 'm1', segmentId: 's1', text: 'Open a fake request today.' });
  expect(await dictionary.list(t.db, 'u2')).toHaveLength(0);
  await editSegment(t.db, { userId: 'u1', meetingId: 'm1', segmentId: 's1', text: 'Open a pull request today.' });
  expect(await dictionary.list(t.db, 'u1')).toHaveLength(0);
  await editSegment(t.db, { userId: 'u1', meetingId: 'm1', segmentId: 's1', text: 'Open a Pullify request today.' });
  expect(await dictionary.list(t.db, 'u1')).toMatchObject([{ from: 'pull', to: 'Pullify', origin: 'learned' }]);
  expect(t.sqlite.query("SELECT text,raw_text,is_edited FROM transcript_segments WHERE id='s1'").get())
    .toEqual({ text: 'Open a Pullify request today.', raw_text: 'Open a pool request today.', is_edited: 1 });
});

test('competing writes respect capacity while existing entries stay editable', async () => {
  const t = setup();
  t.sqlite.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<499)
    INSERT INTO personal_dictionary(id,user_id,source_key,from_text,to_text,created_at,updated_at)
    SELECT 'word_'||i,'u1','source_'||i,'source_'||i,'target_'||i,1,1 FROM n`);
  // This fake serializes SQLite writes; the insert predicate supplies atomic admission.
  const results = await Promise.all([
    dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha' }], 'manual'),
    dictionary.remember(t.db, 'u1', [{ from: 'misheard beta', to: 'Beta' }], 'manual'),
  ]);
  expect(results.reduce((a, b) => a+b, 0)).toBe(1);
  expect(await dictionary.list(t.db, 'u1')).toHaveLength(500);
  expect(await dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha revised' }], 'manual')).toBe(1);
  expect(await dictionary.remember(t.db, 'u1', [{ from: 'misheard alpha', to: 'Alpha revised' }], 'manual')).toBe(0);
});

test('manual dictionary writes report saved versus already unchanged from server state', async () => {
  const t = setup();
  const body = { from: 'pool', to: 'pull' };
  const saved = await t.request('PUT', body);
  expect(await saved.json()).toMatchObject({ learned: 1, status: 'saved' });
  const unchanged = await t.request('PUT', body);
  expect(await unchanged.json()).toMatchObject({ learned: 0, status: 'unchanged' });
});

test('casing and spacing updates are real writes, not incorrectly labeled unchanged', async () => {
  const t = setup();
  for (const from of ['pool', 'Pool', ' pool ']) {
    const result = await t.request('PUT', { from, to: 'pull' });
    expect(await result.json()).toMatchObject({ learned: 1, status: 'saved' });
  }
  expect(await (await t.request('PUT', { from: ' pool ', to: 'pull' })).json()).toMatchObject({ learned: 0, status: 'unchanged' });
});

test('the dictionary page hides everyday-word fixes learned before the stricter test, but keeps hand-made ones', async () => {
  const t = setup();
  t.sqlite.run(`INSERT INTO personal_dictionary (id, user_id, source_key, from_text, to_text, origin, seen, created_at, updated_at) VALUES
    ('w1', 'u1', 'yeah', 'Yeah', 'Yes', 'learned', 1, 1, 1), ('w2', 'u1', 'friday', 'Friday', 'Monday', 'learned', 3, 1, 1),
    ('w3', 'u1', 'eavsy', 'Eavsy', 'Eavesy', 'learned', 1, 1, 1), ('w4', 'u1', 'okay', 'Okay', 'OK', 'manual', 1, 1, 1)`);
  const { entries } = await (await t.request('GET', null)).json() as { entries: { from: string }[] };
  expect(entries.map(e => e.from).sort()).toEqual(['Eavsy', 'Okay']);
  expect((await dictionary.listForTranscription(t.db, 'u1')).map(e => e.from).sort()).toEqual(['Okay']);
  // Adding a hidden row's "heard as" by hand replaces it, and it shows again as the user's own.
  expect(await (await t.request('PUT', { from: 'Friday', to: 'Fri' })).json()).toMatchObject({ learned: 1, status: 'saved' });
  const after = (await (await t.request('GET', null)).json() as { entries: { from: string; to: string; origin: string }[] }).entries;
  expect(after.find(e => e.from === 'Friday')).toMatchObject({ to: 'Fri', origin: 'manual' });
});
