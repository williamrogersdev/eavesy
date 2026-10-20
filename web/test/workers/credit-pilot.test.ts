import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/d1';
import { createAiRunner, type CreditEnv } from '../../src/lib/ai/credit-runner';
import { guardedImportWrite } from '../../src/server/processing/import-guard';
import type { ProcessingEnv } from '../../src/server/processing/shared';
import { summaries, transcriptSegments } from '../../src/db/schema';
import { insertMeeting, insertUser, testEnv } from './support';
beforeAll(async () => { await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS); });
it('rolls back all reservation statements on a real D1 daily-budget rejection', async () => {
  const day = `day:${new Date().toISOString().slice(0, 10)}`;
  await testEnv.DB.prepare('INSERT INTO ai_credit_budgets(scope,reserved_microusd) VALUES (?,?)').bind(day,1_000_000).run();
  const env: CreditEnv = { DB:testEnv.DB, AI_CREDITS_ENABLED:'true', WORKERS_AI_ACCOUNT_ID:'11111111111111111111111111111111', AI_CREDITS_EXPECTED_ACCOUNT_ID:'11111111111111111111111111111111', WORKERS_AI_API_KEY:'fake', AI_CREDITS_STOP_AT:'2099-01-01',AI_CREDITS_BUDGET_USD:'100',AI_CREDITS_DAILY_BUDGET_USD:'1' };
  let calls=0;
  const ai=createAiRunner(env,'test',async () => { calls++; return Response.json({success:true,result:{data:[[1]]}}); });
  await expect(ai.run('@cf/qwen/qwen3-embedding-0.6b',{text:['hello']})).rejects.toThrow('budget');
  expect(calls).toBe(0);
  expect(await testEnv.DB.prepare("SELECT * FROM ai_credit_budgets WHERE scope='programme'").first()).toBeNull();
  expect((await testEnv.DB.prepare('SELECT count(*) n FROM ai_credit_usage').first<{n:number}>())?.n).toBe(0);
});
it('guards transcript insert and conflict update against cancellation at write time', async () => {
  await insertUser('pilot-owner');
  await insertMeeting({ id:'pilot-meeting', userId:'pilot-owner', status:'processing' });
  await testEnv.DB.prepare("INSERT INTO recording_imports(meeting_id,user_id,fingerprint,segment_count,duration_ms,state,created_at) VALUES ('pilot-meeting','pilot-owner','f',1,1000,'processing',1)").run();
  const db=drizzle(testEnv.DB);
  const query=db.insert(transcriptSegments).values({id:'pilot-line',meetingId:'pilot-meeting',startMs:0,endMs:1000,text:'Original words'}).onConflictDoUpdate({target:transcriptSegments.id,set:{text:'Replacement words'}}).toSQL();
  const env={DB:testEnv.DB} as ProcessingEnv;
  await guardedImportWrite(env,query,'pilot-meeting').run();
  await testEnv.DB.prepare("UPDATE recording_imports SET state='cancelled' WHERE meeting_id='pilot-meeting'").run();
  await guardedImportWrite(env,query,'pilot-meeting').run();
  expect((await db.select().from(transcriptSegments))[0].text).toBe('Original words');
  await db.delete(transcriptSegments);
  await guardedImportWrite(env,query,'pilot-meeting').run();
  expect(await db.select().from(transcriptSegments)).toEqual([]);
});

it('guards the summary upsert shape and rejects SQL value expressions', async () => {
  const db=drizzle(testEnv.DB);
  const query=db.insert(summaries).values({id:'pilot-summary',meetingId:'pilot-meeting',tldr:'Original summary',generatedByModel:'test',generatedAt:1}).onConflictDoUpdate({target:summaries.meetingId,set:{tldr:'Replacement summary'}}).toSQL();
  const env={DB:testEnv.DB} as ProcessingEnv;
  await testEnv.DB.prepare("UPDATE recording_imports SET state='processing' WHERE meeting_id='pilot-meeting'").run();
  await guardedImportWrite(env,query,'pilot-meeting').run();
  await testEnv.DB.prepare("UPDATE recording_imports SET state='cancelled' WHERE meeting_id='pilot-meeting'").run();
  await guardedImportWrite(env,query,'pilot-meeting').run();
  expect((await db.select().from(summaries))[0].tldr).toBe('Original summary');
  expect(() => guardedImportWrite(env,{sql:'insert into summaries values (coalesce(?, ?))',params:['a','b']},'pilot-meeting')).toThrow('Unsupported');
});
