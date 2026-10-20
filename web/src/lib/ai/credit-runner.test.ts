import { describe, expect, test } from 'bun:test';
import { createFakeEnv } from '@/server/testing/fake-env';
import { createAiRunner, LIBRARY_MODEL, reservation } from './credit-runner';
import { encodeWav } from '../imports/wav';
const MODEL = '@cf/qwen/qwen3-embedding-0.6b';
function setup(budget = '1') {
  const t = createFakeEnv();
  const env = { ...t.env, AI_CREDITS_ENABLED: 'true', WORKERS_AI_ACCOUNT_ID: '11111111111111111111111111111111', AI_CREDITS_EXPECTED_ACCOUNT_ID: '11111111111111111111111111111111', WORKERS_AI_API_KEY: 'test-only', AI_CREDITS_STOP_AT: '2099-01-01T00:00:00Z', AI_CREDITS_BUDGET_USD: budget, AI_CREDITS_DAILY_BUDGET_USD: budget };
  const calls: string[] = [];
  const transport: typeof fetch = async input => { calls.push(String(input)); return Response.json({ success: true, result: { data: [[1]] } }); };
  return { ...t, env, calls, transport };
}
describe('credit routing and accounting', () => {
  test('disabled mode uses existing binding and wrong-account mode fails before fetch', async () => {
    const t = setup();
    expect(createAiRunner({ ...t.env, AI_CREDITS_ENABLED: 'false' }, 'test', t.transport)).toBe(t.env.AI);
    expect(() => createAiRunner({ ...t.env, WORKERS_AI_ACCOUNT_ID: 'wrong' }, 'test', t.transport)).toThrow('account');
    expect(t.calls).toHaveLength(0);
  });
  test('conditional debit prevents concurrent requests from exceeding the budget', async () => {
    const t = setup('0.01');
    const wav = encodeWav(new Float32Array(160));
    const audio = btoa(String.fromCharCode(...wav));
    const ai = createAiRunner(t.env, 'test', t.transport);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => ai.run('@cf/openai/whisper-large-v3-turbo', { audio })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toContain(`/accounts/${'11111111111111111111111111111111'}/ai/run/`);
    expect((t.sqlite.query("SELECT reserved_microusd n FROM ai_credit_budgets WHERE scope='programme'").get() as { n: number }).n).toBe(5130);
  });
  test('timeouts and provider errors retain reservations and never expose provider bodies', async () => {
    const t = setup();
    const ai = createAiRunner(t.env, 'test', async () => new Response('private submitted words', { status: 429 }));
    await expect(ai.run(MODEL, { text: ['hello'] })).rejects.toThrow('429');
    expect(t.sqlite.query('SELECT state FROM ai_credit_usage').get()).toEqual({ state: 'failed' });
    expect((t.sqlite.query('SELECT sum(reserved_microusd) n FROM ai_credit_budgets').get() as { n: number }).n).toBeGreaterThan(0);
  });
  test('pause and expiry fail closed with no request', async () => {
    const t = setup();
    for (const override of [{ AI_CREDITS_PAUSED: 'true' }, { AI_CREDITS_STOP_AT: '2000-01-01' }, { AI_CREDITS_STOP_AT: '' }]) {
      await expect(createAiRunner({ ...t.env, ...override }, 'test', t.transport).run(MODEL, { text: ['hi'] })).rejects.toThrow();
    }
    expect(t.calls).toHaveLength(0);
  });
  test('unknown models, unbounded generation and unverified compressed audio are rejected', () => {
    expect(() => reservation('unknown', {})).toThrow();
    expect(() => reservation(LIBRARY_MODEL, { max_tokens: 100_000 })).toThrow();
    expect(() => reservation('@cf/openai/whisper-large-v3-turbo', { audio: btoa('compressed') })).toThrow();
  });
});
