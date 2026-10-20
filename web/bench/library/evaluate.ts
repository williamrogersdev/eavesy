/** Offline contracts by default. --live explicitly sends only synthetic fixtures. */
import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cases } from './fixtures';
import { fakeD1 } from '../../src/server/testing/fake-env';
import { answerLibrary, validateLibraryAnswer } from '../../src/lib/ai/library-answer';
import { createAiRunner, LIBRARY_MODEL, PRICING_VERSION, TEXT_MODELS } from '../../src/lib/ai/credit-runner';
import type { CreditEnv } from '../../src/lib/ai/credit-runner';

const live = process.argv.includes('--live');
const output = join(import.meta.dir, 'out');
mkdirSync(output, { recursive: true, mode: 0o700 });
if (!live) {
  const source = cases[0].sources[0];
  const reply = { claims: [{ text: source.text, kind: 'decision', citations: [{ sourceId: source.id, quote: source.text }] }] };
  validateLibraryAnswer(reply, [source]);
  for (const invalid of [{ claims: [{ ...reply.claims[0], citations: [{ sourceId: 'other-user', quote: source.text }] }] }, { claims: [{ ...reply.claims[0], citations: [{ sourceId: source.id, quote: 'An invented source quote.' }] }] }]) {
    let rejected = false;
    try { validateLibraryAnswer(invalid, [source]); } catch { rejected = true; }
    if (!rejected) throw new Error('Evidence boundary failed');
  }
  const report = { mode: 'offline-contracts', casesAvailable: cases.length, evidenceBoundaryChecks: 3, passed: true, modelQualityMeasured: false };
  writeFileSync(join(output, 'offline.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
} else {
  const maxArg = process.argv.find(a => a.startsWith('--max-usd='));
  if (!maxArg || !Number.isFinite(Number(maxArg.split('=')[1])) || Number(maxArg.split('=')[1]) <= 0 || Number(maxArg.split('=')[1]) > 100) throw new Error('Live evaluation requires --max-usd=<approved cumulative ceiling, at most 100>');
  const ceiling = maxArg.split('=')[1];
  const ledgerPath = join(output, 'ledger.sqlite');
  const sqlite = new Database(ledgerPath, { create: true });
  chmodSync(ledgerPath, 0o600);
  sqlite.exec(readFileSync(join(import.meta.dir, '../../drizzle/0032_ai_credit_budget.sql'), 'utf8').replaceAll('--> statement-breakpoint', '').replaceAll('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS '));
  const env: CreditEnv = {
    DB: fakeD1(sqlite) as CreditEnv['DB'], AI_CREDITS_ENABLED: 'true',
    WORKERS_AI_ACCOUNT_ID: process.env.WORKERS_AI_ACCOUNT_ID,
    AI_CREDITS_EXPECTED_ACCOUNT_ID: process.env.AI_CREDITS_EXPECTED_ACCOUNT_ID,
    WORKERS_AI_API_KEY: process.env.WORKERS_AI_API_KEY,
    AI_CREDITS_BUDGET_USD: ceiling, AI_CREDITS_DAILY_BUDGET_USD: ceiling,
    AI_CREDITS_STOP_AT: process.env.AI_CREDITS_STOP_AT,
  };
  if (!env.AI_CREDITS_EXPECTED_ACCOUNT_ID || env.WORKERS_AI_ACCOUNT_ID !== env.AI_CREDITS_EXPECTED_ACCOUNT_ID) throw new Error('Set WORKERS_AI_ACCOUNT_ID to the credit account');
  const ai = createAiRunner(env, 'synthetic-evaluation');
  const compare = process.argv.includes('--compare');
  const models = compare ? Object.keys(TEXT_MODELS) : [LIBRARY_MODEL];
  const results: unknown[] = [];
  for (const model of models) for (const c of cases) {
    const start = Date.now();
    try {
      const answer = await answerLibrary(ai, c.question, c.sources, model);
      const text = answer.claims.map(x => x.text).join(' ').toLowerCase();
      const passed = answer.abstained === c.expected.abstain
        && (!c.expected.includes || text.includes(c.expected.includes.toLowerCase()))
        && !(c.expected.excludes ?? []).some(term => text.includes(term.toLowerCase()));
      results.push({ model, id: c.id, passed, answer, latencyMs: Date.now() - start });
    } catch (e) { results.push({ model, id: c.id, passed: false, error: e instanceof Error ? e.message : 'Inference or evidence validation failed', latencyMs: Date.now() - start }); }
  }
  const path = join(output, `live-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify({ pricingVersion: PRICING_VERSION, mode: 'live-synthetic', automaticChecksOnly: true, requiresHumanQualityReview: true, results }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ cases: results.length, output: path, billingVerified: false }));
  sqlite.close();
}
