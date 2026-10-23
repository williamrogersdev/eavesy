import type { D1Database } from '@cloudflare/workers-types';
import { wavDurationMs } from '../imports/wav';
import type { WorkersAiRunner } from './embed';

export const LIBRARY_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
export const TEXT_MODELS: Record<string, { input: number; output: number }> = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { input: 0.293, output: 2.253 },
  '@cf/qwen/qwen3-30b-a3b-fp8': { input: 0.051, output: 0.335 },
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 0.351, output: 0.555 },
};
export const PRICING_VERSION = '2026-10-20';
export interface CreditEnv {
  AI?: WorkersAiRunner;
  DB: D1Database;
  WORKERS_AI_ACCOUNT_ID?: string;
  AI_CREDITS_EXPECTED_ACCOUNT_ID?: string;
  WORKERS_AI_API_KEY?: string;
  AI_CREDITS_ENABLED?: string;
  AI_CREDITS_PAUSED?: string;
  AI_CREDITS_STOP_AT?: string;
  AI_CREDITS_BUDGET_USD?: string;
  AI_CREDITS_DAILY_BUDGET_USD?: string;
  AI_SUMMARY_PROVIDER?: string;
}

function limit(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 50_000) throw new Error('Invalid AI credit budget');
  return Math.floor(n * 1_000_000);
}

/** Upper estimate, not invoice accounting. Failed/ambiguous calls keep their reservation. */
export function reservation(model: string, input: unknown): number {
  if (!input || typeof input !== 'object') throw new Error('Invalid AI input');
  const json = JSON.stringify(input);
  const bytes = new TextEncoder().encode(json).byteLength;
  if (bytes > 15_000_000) throw new Error('AI input too large');
  if (model === '@cf/openai/whisper-large-v3-turbo') {
    const audio = (input as { audio?: unknown }).audio;
    if (typeof audio !== 'string' || audio.length > 10_300_000) throw new Error('Credit audio must be a bounded PCM WAV segment');
    try { wavDurationMs(decodeAudio(audio)); }
    catch { throw new Error('Credit audio must be a bounded PCM WAV segment'); }
    // Reserve ten minutes for an import segment validated to at most four.
    return 5_130;
  }
  if (model === '@cf/qwen/qwen3-embedding-0.6b') {
    if (bytes > 128_000) throw new Error('Embedding batch too large');
    return Math.max(1, Math.ceil(bytes * 0.012));
  }
  const price = TEXT_MODELS[model];
  if (!price) throw new Error('Model is not approved for credit routing');
  const tokens = (input as { max_tokens?: unknown }).max_tokens;
  if (!Number.isSafeInteger(tokens) || Number(tokens) < 1 || Number(tokens) > 4096 || bytes > 100_000) {
    throw new Error('Unbounded AI generation');
  }
  // UTF-8 bytes conservatively bound tokens; include template overhead.
  return Math.ceil((bytes + 4096) * price.input + Number(tokens) * price.output);
}

export function creditsConfigured(env: CreditEnv): boolean {
  return env.AI_CREDITS_ENABLED === 'true';
}

/**
 * The purposes the credit pilot pays for (docs/pilots/workers-ai-credit-pilot.md):
 * imports, transcript-backed library answers and the MCP library tools. Every
 * other Workers AI call (meeting embeddings, search, translation, transcript
 * repair) predates the pilot and runs on the account's own `AI` binding, so
 * pausing or ending the pilot cannot take them down with it.
 */
export function isCreditPurpose(purpose: string): boolean {
  return purpose.startsWith('import-') || purpose === 'library-answer' || purpose === 'mcp-library';
}

export function createAiRunner(env: CreditEnv, purpose: string, transport: typeof fetch = fetch): WorkersAiRunner {
  if (!creditsConfigured(env) || !isCreditPurpose(purpose)) {
    if (!env.AI) throw new Error('AI binding unavailable');
    return env.AI;
  }
  // An explicit credits mode must never silently fall back to another account.
  const accountId = env.AI_CREDITS_EXPECTED_ACCOUNT_ID;
  if (!accountId || !/^[a-f0-9]{32}$/.test(accountId) || env.WORKERS_AI_ACCOUNT_ID !== accountId || !env.WORKERS_AI_API_KEY) {
    throw new Error('AI credits account or credential is not configured');
  }
  return {
    async run(model, input) {
      const stop = Date.parse(env.AI_CREDITS_STOP_AT ?? '');
      if (env.AI_CREDITS_PAUSED === 'true' || !Number.isFinite(stop) || Date.now() >= stop) {
        throw new Error('AI credit processing is paused or expired');
      }
      const totalLimit = limit(env.AI_CREDITS_BUDGET_USD);
      const dayLimit = limit(env.AI_CREDITS_DAILY_BUDGET_USD);
      const amount = reservation(model, input);
      const day = new Date().toISOString().slice(0, 10);
      const id = crypto.randomUUID();
      try {
        // D1 batch is a transaction. A failed guard violates NOT NULL and rolls
        // back both scopes and the usage row, before any network request.
        await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO ai_credit_budgets(scope) VALUES (?)').bind('programme'),
          env.DB.prepare('INSERT OR IGNORE INTO ai_credit_budgets(scope) VALUES (?)').bind(`day:${day}`),
          env.DB.prepare(`INSERT INTO ai_credit_budgets(scope, reserved_microusd)
            SELECT '__rejected_reservation', NULL WHERE
            (SELECT reserved_microusd FROM ai_credit_budgets WHERE scope = 'programme') + ? > ?
            OR (SELECT reserved_microusd FROM ai_credit_budgets WHERE scope = ?) + ? > ?`)
            .bind(amount, totalLimit, `day:${day}`, amount, dayLimit),
          env.DB.prepare('UPDATE ai_credit_budgets SET reserved_microusd = reserved_microusd + ? WHERE scope IN (?, ?)')
            .bind(amount, 'programme', `day:${day}`),
          env.DB.prepare(`INSERT INTO ai_credit_usage
            (id, account_id, model, purpose, reserved_microusd, state, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)`)
            .bind(id, accountId, model, purpose.slice(0, 80), amount, Date.now()),
        ]);
      } catch { throw new Error('AI credit budget exhausted or unavailable'); }
      try {
        const response = await transport(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.WORKERS_AI_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(90_000),
        });
        // Provider error bodies may contain submitted text. Never log or forward them.
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Workers AI request failed (${response.status})`); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Empty Workers AI response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 8_000_000) throw new Error('Workers AI response too large');
            chunks.push(next.value);
          }
        } finally { await reader.cancel(); }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
        let envelope: unknown;
        try { envelope = JSON.parse(new TextDecoder().decode(data)); } catch { throw new Error('Invalid Workers AI JSON response'); }
        if (!envelope || typeof envelope !== 'object' || !('success' in envelope) || !('result' in envelope) || envelope.success !== true || envelope.result === undefined) throw new Error('Workers AI returned an invalid response');
        const usage = measuredUsage(model, input, envelope.result);
        await env.DB.prepare("UPDATE ai_credit_usage SET state = 'complete', finished_at = ?, estimated_microusd = ?, input_units = ?, output_tokens = ? WHERE id = ?")
          .bind(Date.now(), usage.cost, usage.input, usage.output, id).run();
        return envelope.result;
      } catch (error) {
        await env.DB.prepare("UPDATE ai_credit_usage SET state = 'failed', finished_at = ? WHERE id = ?")
          .bind(Date.now(), id).run();
        throw error;
      }
    },
  };
}

/** Nullable provider counters remain unknown rather than being reported as zero. */
function measuredUsage(model: string, input: unknown, result: unknown): { input: number | null; output: number | null; cost: number | null } {
  if (model.includes('whisper')) {
    const audio = (input as { audio: string }).audio;
    const ms = wavDurationMs(decodeAudio(audio));
    return { input: ms, output: null, cost: Math.ceil(ms / 60_000 * 513) };
  }
  const usage = (result as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })?.usage;
  const units = typeof usage?.prompt_tokens === 'number' && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 ? usage.prompt_tokens : null;
  const output = typeof usage?.completion_tokens === 'number' && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 ? usage.completion_tokens : null;
  const price = TEXT_MODELS[model];
  return { input: units, output, cost: price && units !== null && output !== null ? Math.ceil(units * price.input + output * price.output) : model.includes('embedding') && units !== null ? Math.ceil(units * 0.012) : null };
}

function decodeAudio(audio: string): Uint8Array {
  const binary = atob(audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
