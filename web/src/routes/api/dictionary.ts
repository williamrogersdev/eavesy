import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { rateLimit } from '@/server/rate-limit';
import { dictionaryRequest } from '@/server/dictionary';

async function handle({ request }: { request: Request }) {
  let actor;
  try { actor = await resolveIngestActor(request); }
  catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
  if (request.method !== 'GET') {
    const limit = await rateLimit({ key: `dictionary:${actor.userId}:${actor.deviceId ?? 'browser'}`, limit: 30, windowSec: 60, failMode: 'closed' });
    if (!limit.allowed) return Response.json({ error: 'Too many dictionary changes. Try again shortly.' }, { status: 429, headers: { 'retry-after': String(limit.retryAfterSec) } });
  }
  return dictionaryRequest(request, getDb(), actor);
}
export const Route = createFileRoute('/api/dictionary')({ server: { handlers: {
  GET: handle, POST: handle, PUT: handle, DELETE: handle,
} } });
