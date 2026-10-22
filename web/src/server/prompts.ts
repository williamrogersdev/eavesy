import { z } from 'zod';
import { getDb, type AppDb } from '@/db/client';
import * as prompts from '@/db/repo/prompts';
import { isRecord } from '@/lib/json';
import { PROMPT_LIMITS } from '@/lib/prompts';
import { resolveIngestActor, type ResolvedIngestActor } from './device-auth';
import { rateLimit } from './rate-limit';

const name = z.string().trim().min(1).max(PROMPT_LIMITS.name);
const body = z.string().max(PROMPT_LIMITS.body).refine((text) => text.trim().length > 0);
const createSchema = z.object({ name, body });
const updateSchema = z.union([
  z.object({ used: z.literal(true) }).strict(),
  z.object({ name: name.optional(), body: body.optional() }).strict()
    .refine((fields) => fields.name !== undefined || fields.body !== undefined),
]);

/**
 * Saved prompts, for the browser and a paired Mac alike; the account always
 * comes from authentication. `id` is set for one prompt's PATCH and DELETE.
 */
export async function promptsRequest(request: Request, db: AppDb, actor: ResolvedIngestActor, id?: string): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  if (!id) {
    if (request.method === 'GET') return json({ items: await prompts.list(db, actor.userId) });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const parsed = createSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json({ error: 'invalid_request' }, 400);
    try {
      return json({ prompt: await prompts.create(db, actor.userId, parsed.data) }, 201);
    } catch (error) {
      if (error instanceof prompts.TooManyPrompts) return json({ error: 'too_many_prompts' }, 400);
      if (error instanceof prompts.SlugConflict) return json({ error: 'slug_conflict' }, 409);
      throw error;
    }
  }
  if (request.method === 'DELETE') {
    await prompts.remove(db, actor.userId, id);
    return json({ ok: true });
  }
  if (request.method !== 'PATCH') return json({ error: 'method_not_allowed' }, 405);
  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  const prompt = 'used' in parsed.data
    ? await prompts.markUsed(db, actor.userId, id)
    : await prompts.update(db, actor.userId, id, parsed.data);
  return prompt ? json({ prompt }) : json({ error: 'not_found' }, 404);
}

/**
 * Whether a PATCH only counts a paste: exactly `{ used: true }`, so an edit
 * can't ride on the looser budget. Reads a copy, so the handler can still read the body.
 */
async function countsUse(request: Request): Promise<boolean> {
  const body: unknown = await request.clone().json().catch(() => null);
  return isRecord(body) && body.used === true && Object.keys(body).length === 1;
}

/** `/api/prompts` and `/api/prompts/$id`: signed in, and writes rate-limited per device. */
export async function handlePrompts(request: Request, id?: string): Promise<Response> {
  let actor;
  try { actor = await resolveIngestActor(request); }
  catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
  if (request.method !== 'GET') {
    // Counting pastes has its own budget, so a burst of pastes never blocks an edit.
    const counting = request.method === 'PATCH' && await countsUse(request);
    const limit = await rateLimit({ key: `prompts${counting ? '-used' : ''}:${actor.userId}:${actor.deviceId ?? 'browser'}`, limit: counting ? 240 : 60, windowSec: 60, failMode: 'closed' });
    if (!limit.allowed) return Response.json({ error: 'Too many prompt changes. Try again shortly.' }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  }
  return promptsRequest(request, getDb(), actor, id);
}
