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
      const result = await askLibrary(t.db, 'u1', 'launch', { ai: { async run() { t.sqlite.exec(update); return { response: JSON.stringify({claims:[{text:"Launch on Friday.",kind:"decision",sourceIds:["sm1"]}],unanswered:[]}) }; } } });
      expect(result.abstained).toBe(true); expect(result.claims).toEqual([]);
    }
  });
  test('no matching sources abstains without inference', async () => {
    const t = setup(); let calls = 0;
    const result = await askLibrary(t.db, 'u1', 'nonexistent', { ai: { async run() { calls++; throw new Error('unexpected'); } } });
    expect(result.abstained).toBe(true); expect(calls).toBe(0);
  });
});

describe('retrieval regression cases', () => {
  test('explicit title returns the full named recording, with no semantic cross-source fallback', async () => {
    const t = setup();
    t.sqlite.run("UPDATE meetings SET title='Older launch notes' WHERE id='m1'");
    for (let i=0;i<40;i++) t.sqlite.run('INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES (?, ?, ?, ?, ?)', [`old${i}`,'m1',i*2000+3000,i*2000+4000,`Additional detail number ${i}.`]);
    const ai = { async run() { throw new Error('Title retrieval must not invoke AI'); } };
    const sources = await librarySources(t.db,'u1','In the recording titled "Older launch notes", what was agreed?',{ ai });
    expect(sources).toHaveLength(41);
    expect(new Set(sources.map(s=>s.meetingId))).toEqual(new Set(['m1']));
    expect(await librarySources(t.db,'u1','In the recording titled "m2", what was agreed?',{ ai })).toEqual([]);
    expect(await librarySources(t.db,'u1','In the recording titled "m3", what was agreed?',{ ai })).toEqual([]);
    expect(await librarySources(t.db,'u1','In the recording titled "Unknown", what was agreed?',{ ai })).toEqual([]);
  });
  test('older relevant evidence is ranked before the SQL candidate limit', async () => {
    const t = setup();
    t.sqlite.run("INSERT INTO meetings(id,user_id,title,started_at,source,status,created_at,updated_at) VALUES ('recent','u1','Recent',999,'desktop','complete',1,1)");
    for (let i=0;i<550;i++) t.sqlite.run('INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES (?, ?, ?, ?, ?)', [`new${i}`,'recent',i*2000,i*2000+1000,'Discuss launch.']);
    const sources = await librarySources(t.db,'u1','launch Friday');
    expect(sources.some(s=>s.id==='sm1')).toBe(true);
  });
});

test('Unicode title and lexical matching use consistent case folding', async () => {
  const t = setup();
  t.sqlite.run("UPDATE meetings SET title='ÉTÉ МОСКВА' WHERE id='m1'");
  t.sqlite.run("UPDATE transcript_segments SET text='ÉLÉPHANT МОСКВА' WHERE id='sm1'");
  expect((await librarySources(t.db,'u1','éléphant москва')).map(s=>s.meetingId)).toEqual(['m1']);
  expect((await librarySources(t.db,'u1','In the recording titled " été москва ", what was discussed?')).map(s=>s.meetingId)).toEqual(['m1']);
});
test('later details in long titled recordings rank ahead of the context budget', async () => {
  const t = setup();
  for(let i=0;i<300;i++) t.sqlite.run('INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES (?, ?, ?, ?, ?)', [`long${i}`,'m1',i*2000+3000,i*2000+4000,'Unrelated discussion. '.repeat(60)]);
  t.sqlite.run("INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES ('last','m1',999000,1000000,'Bring three green apples to the kitchen table.')");
  const question = 'In the recording titled "m1", how many green apples?';
  expect((await librarySources(t.db,'u1',question)).some(s=>s.id==='last')).toBe(true);
  const answer = await askLibrary(t.db,'u1',question,{ai:{async run(){return {response:{claims:[],unanswered:[]}};}}});
  expect(answer.warnings?.[0]).toContain('Additional details may exist');
});

test('case folding avoids expanding German SS and handles dotted capital I', async () => {
  const t = setup();
  t.sqlite.run("UPDATE transcript_segments SET text='MASSE İstanbul' WHERE id='sm1'");
  expect(await librarySources(t.db,'u1','maße')).toEqual([]);
  expect((await librarySources(t.db,'u1','İstanbul')).map(s=>s.meetingId)).toEqual(['m1']);
  expect((await librarySources(t.db,'u1','istanbul')).map(s=>s.meetingId)).toEqual(['m1']);
});

test('non-ASCII query letters cannot rewrite ASCII I or S into false matches', async () => {
  const t = setup();
  t.sqlite.run("UPDATE transcript_segments SET text='INVOICE SUN' WHERE id='sm1'");
  expect(await librarySources(t.db,'u1','ınvoice')).toEqual([]);
  expect(await librarySources(t.db,'u1','ſun')).toEqual([]);
});

test('normal top-K selection deliberately discloses unsearched matching evidence', async () => {
  const t = setup();
  for(let i=0;i<60;i++) t.sqlite.run('INSERT INTO transcript_segments(id,meeting_id,start_ms,end_ms,text) VALUES (?, ?, ?, ?, ?)', [`many${i}`,'m1',i*2000+3000,i*2000+4000,'Discuss launch.']);
  const sources = await librarySources(t.db,'u1','launch');
  expect(sources).toHaveLength(48);
  expect(sources[0].contextTruncated).toBe(true);
});

test('ranked queries stay under D1 binding limits with 30 semantic matches and 16 Unicode terms', async () => {
  const t = setup(); let mostBindings=0;
  const limited = new Proxy(t.env.DB, {get(target, property) {
    if(property==='prepare') return (query:string) => {
      const statement=target.prepare(query);
      return new Proxy(statement,{get(stmt,key){
        if(key==='bind') return (...params:unknown[]) => {
          mostBindings=Math.max(mostBindings,params.length);
          if(params.length>100) throw new Error('D1 bound parameter limit exceeded');
          return stmt.bind(...params);
        };
        return Reflect.get(stmt,key);
      }});
    };
    return Reflect.get(target,property);
  }});
  const db=drizzle(limited,{schema});
  const sources=await librarySources(db,'u1','éléphant москва istanbul pricing invoices shipping timing syncing clipping highlighting filling missing refining writing inviting linking',{
    ai:{async run(){return {data:[Array(1024).fill(0)]};}},
    vectorize:{async query(){return {count:30,matches:Array.from({length:30},(_,i)=>({id:`v${i}`,score:1,metadata:{sourceId:i===0?'m1':`other${i}`}}))};}},
  });
  expect(sources.some(s=>s.meetingId==='m1')).toBe(true);
  expect(mostBindings).toBeLessThanOrEqual(100);
});

test('an explicit title containing a non-I combining dot remains reachable', async () => {
  const t=setup();
  t.sqlite.run("UPDATE meetings SET title=? WHERE id='m1'",['O\u0307mega notes']);
  expect((await librarySources(t.db,'u1','In the recording titled "O\u0307mega notes", what was agreed?')).map(s=>s.meetingId)).toEqual(['m1']);
});
