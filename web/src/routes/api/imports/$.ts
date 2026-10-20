import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import type { ProcessingEnv } from '@/server/processing-worker';
import { importRequest } from '@/server/imports/service';
async function handle({ request, params }: { request: Request; params: { _splat?: string } }) {
  let actor;
  try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
  if (actor.isAnonymous) return Response.json({ error: 'Sign in to import recordings' }, { status: 403 });
  try { return await importRequest(getDb(), getCloudflareContext<ProcessingEnv>().env, actor.userId, params._splat ?? '', request); }
  catch { return Response.json({ error: 'Import operation failed. Please retry.' }, { status: 503 }); }
}
export const Route = createFileRoute('/api/imports/$')({ server: { handlers: { GET: handle, PUT: handle, POST: handle, DELETE: handle } } });
