import { z } from 'zod';
import { getDb, type AppDb } from '@/db/client';
import * as prompts from '@/db/repo/prompts';
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

/** `/api/prompts` and `/api/prompts/$id`: signed in, and writes rate-limited per device. */
export async function handlePrompts(request: Request, id?: string): Promise<Response> {
  let actor;
  try { actor = await resolveIngestActor(request); }
  catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
  if (request.method !== 'GET') {
    const limit = await rateLimit({ key: `prompts:${actor.userId}:${actor.deviceId ?? 'browser'}`, limit: 60, windowSec: 60, failMode: 'closed' });
    if (!limit.allowed) return Response.json({ error: 'Too many prompt changes. Try again shortly.' }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  }
  return promptsRequest(request, getDb(), actor, id);
}
