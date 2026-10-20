import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { dictionaryRequest } from '@/server/dictionary';

async function handle({ request }: { request: Request }) {
  let actor;
  try { actor = await resolveIngestActor(request); }
  catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
  if (Number(request.headers.get('content-length')) > 100_000) return new Response(null, { status: 413 });
  return dictionaryRequest(request, getDb(), actor);
}
export const Route = createFileRoute('/api/dictionary')({ server: { handlers: {
  GET: handle, POST: handle, PUT: handle, DELETE: handle,
} } });
