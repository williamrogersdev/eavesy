import { z } from 'zod';
import { getDb, type AppDb } from '@/db/client';
import * as feedback from '@/db/repo/agent-feedback';
import * as prompts from '@/db/repo/prompts';
import { anthropic } from '@/lib/ai/client';
import { mergeFeedback, type MergeClient } from '@/lib/ai/merge-prompt-feedback';
import { PROMPT_LIMITS } from '@/lib/prompts';
import { resolveIngestActor, type ResolvedIngestActor } from './device-auth';
import { guardSpend, guardUserQuota, rateLimit, refundSpend, refundUserQuota } from './rate-limit';

export type { MergeClient };

/**
 * What agents reported over MCP (report_feedback), for the user to apply or
 * dismiss. Nothing an agent sends changes a prompt by itself: the user sees a
 * preview of the new text and accepts it.
 */

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
const id = z.string().min(1).max(64);
const ids = z.array(id).max(200);
const dismissSchema = z.object({ ids: ids.min(1), status: z.literal('dismissed') }).strict();
const applySchema = z.object({
  promptId: id,
  expectedBody: z.string().max(PROMPT_LIMITS.body),
  body: z.string().max(PROMPT_LIMITS.body).refine((text) => text.trim().length > 0),
  ids,
}).strict();
const mergeSchema = z.object({ promptId: id, ids: ids.min(1).optional() }).strict();

async function actorOr401(request: Request): Promise<ResolvedIngestActor | Response> {
  try { return await resolveIngestActor(request); }
  catch { return json({ error: 'unauthenticated' }, 401); }
}

async function writesAllowed(actor: ResolvedIngestActor): Promise<Response | null> {
  const limit = await rateLimit({ key: `agent-feedback:${actor.userId}:${actor.deviceId ?? 'browser'}`, limit: 60, windowSec: 60, failMode: 'closed' });
  return limit.allowed ? null : Response.json({ error: 'Too many changes. Try again shortly.' }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
}

/** GET lists open reports; PATCH dismisses some. Always the caller's own. */
export async function handleFeedback(request: Request, db: AppDb = getDb()): Promise<Response> {
  const actor = await actorOr401(request);
  if (actor instanceof Response) return actor;
  if (request.method === 'GET') return json({ items: await feedback.listOpen(db, actor.userId) });
  if (request.method !== 'PATCH') return json({ error: 'method_not_allowed' }, 405);
  const limited = await writesAllowed(actor);
  if (limited) return limited;
  const parsed = dismissSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  return json({ dismissed: await feedback.dismiss(db, actor.userId, parsed.data.ids) });
}

/**
 * POST: writes the text the user accepted into their prompt and marks those
 * reports applied, only if the prompt still reads `expectedBody`; 409 with the
 * current prompt otherwise.
 */
export async function handleApply(request: Request, db: AppDb = getDb()): Promise<Response> {
  const actor = await actorOr401(request);
  if (actor instanceof Response) return actor;
  const limited = await writesAllowed(actor);
  if (limited) return limited;
  const parsed = applySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  const { promptId, ...fields } = parsed.data;
  const result = await feedback.applyToPrompt(db, actor.userId, promptId, fields);
  if (result.status === 'not_found') return json({ error: 'not_found' }, 404);
  if (result.status === 'conflict') return json({ error: 'prompt_changed', prompt: result.prompt }, 409);
  return json({ prompt: result.prompt });
}

/**
 * POST: one proposed rewrite of a prompt from the agents' open reports on it
 * (Haiku, reports fenced as data). Stores nothing: the user previews it and
 * applies it or not. Charged to its own daily quota and the spend budget,
 * and given back on any failure.
 */
export async function handleMerge(request: Request, client: () => MergeClient = anthropic, db: AppDb = getDb()): Promise<Response> {
  const actor = await actorOr401(request);
  if (actor instanceof Response) return actor;
  const limited = await writesAllowed(actor);
  if (limited) return limited;
  const parsed = mergeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  const prompt = await prompts.get(db, actor.userId, parsed.data.promptId);
  if (!prompt) return json({ error: 'not_found' }, 404);
  const items = await feedback.openForPrompt(db, actor.userId, prompt.id, parsed.data.ids);
  // Nothing to merge: no model call, and nothing charged.
  if (!items.length) return json({ error: 'no_feedback' }, 400);
  const chargedAt = Date.now();
  const refund = () => refundUserQuota(actor.userId, 'prompt-feedback-merge', chargedAt);
  const quota = await guardUserQuota(actor.userId, 'prompt-feedback-merge', chargedAt);
  if (quota) return quota;
  // An unreachable budget counter fails closed: give the quota back and say so, rather than a bare 500.
  const spend = await guardSpend(request, 'prompt-feedback-merge', { perMin: 20, perDay: 2_000 })
    .catch((error: unknown) => {
      // Metadata only: no prompt or report text.
      console.error(JSON.stringify({ message: 'prompt feedback merge spend check failed', error: error instanceof Error ? error.message : 'unknown error' }));
      return json({ error: 'Couldn’t merge the suggestions right now.' }, 503);
    });
  if (spend) { await refund(); return spend; }
  try {
    const result = await mergeFeedback(client(), prompt.body, items);
    return json({ ...result, basedOn: prompt.body, ids: items.map((item) => item.id) });
  } catch {
    await Promise.allSettled([refund(), refundSpend('prompt-feedback-merge', chargedAt)]);
    return json({ error: 'Couldn’t merge the suggestions right now.' }, 502);
  }
}
