import { describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { createFakeEnv } from '@/server/testing/fake-env';
import { librarySources, askLibrary } from './library-memory';
import { validateLibraryAnswer } from '@/lib/ai/library-answer';
function setup() {
  const t = createFakeEnv();
  t.sqlite.run("INSERT INTO users(id,created_at,updated_at) VALUES ('u1',1,1),('u2',1,1)");
  for (const [id, user, deleted] of [['m1','u1',null],['m2','u2',null],['m3','u1',1]] as const) {
    t.sqlite.run('INSERT INTO meetings(id,user_id,title,started_at,source,status,created_at,updated_at,deleted_at) VALUES (?,?,?,1,\'import\',\'complete\',1,1,?)', [id,user,id,deleted]);
    t.sqlite.run('INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES (?,?,1000,2000,?)', [`s${id}`,id,'We agreed to launch on Friday.']);
  }
  return { ...t, db: drizzle(t.env.DB,{schema}) };
}
const reply = { claims: [{ text: 'Launch on Friday.', kind: 'decision', citations: [{ sourceId: 'sm1', quote: 'launch on Friday' }] }] };
describe('library evidence boundaries', () => {
  test('retrieval excludes other owners and deleted sources', async () => {
    const t = setup(); const sources = await librarySources(t.db, 'u1', 'launch');
    expect(sources.map(s => s.meetingId)).toEqual(['m1']);
    expect(validateLibraryAnswer(reply, sources).claims[0].citations[0].href).toContain('?t=1');
    expect(() => validateLibraryAnswer({ claims: [{ ...reply.claims[0], citations: [{ sourceId:'sm2',quote:'launch on Friday' }] }] }, sources)).toThrow();
    expect(() => validateLibraryAnswer({ claims: [{ ...reply.claims[0], citations: [{ sourceId:'sm1',quote:'Invented quote' }] }] }, sources)).toThrow();
  });
  test('cancelled import partial rows are retained for resume but never answer evidence', async () => {
    const t = setup();
    t.sqlite.run("UPDATE meetings SET status='failed',status_error='Import cancelled' WHERE id='m1'");
    expect(await librarySources(t.db, 'u1', 'launch')).toEqual([]);
    let calls = 0;
    const answer = await askLibrary(t.db, 'u1', 'launch', { ai: { async run() { calls++; throw new Error('unexpected'); } } });
    expect(answer.abstained).toBe(true);
    expect(calls).toBe(0);
    expect(t.sqlite.query("SELECT count(*) n FROM transcript_segments WHERE meeting_id='m1'").get()).toEqual({n:1});
  });
  test('deletion or editing during inference invalidates the answer', async () => {
    for (const update of ["UPDATE meetings SET deleted_at=1 WHERE id='m1'", "UPDATE transcript_segments SET text='A changed decision' WHERE id='sm1'"]) {
      const t = setup();
      const result = await askLibrary(t.db, 'u1', 'launch', { ai: { async run() { t.sqlite.exec(update); return { response: JSON.stringify(reply) }; } } });
      expect(result.abstained).toBe(true); expect(result.claims).toEqual([]);
    }
  });
  test('no matching sources abstains without inference', async () => {
    const t = setup(); let calls = 0;
    const result = await askLibrary(t.db, 'u1', 'nonexistent', { ai: { async run() { calls++; throw new Error('unexpected'); } } });
    expect(result.abstained).toBe(true); expect(calls).toBe(0);
  });
});
