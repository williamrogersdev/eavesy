import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { type BotEnv, cancelBot } from '@/server/meeting-bots/service';

export const Route = createFileRoute('/api/meeting-bots/$id')({ server: { handlers: {
  DELETE: async ({ params }) => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    try { return await cancelBot(getDb(), getCloudflareContext<BotEnv>().env, actor.userId, params.id); }
    catch { return Response.json({ error: 'The notetaker could not be stopped. Please retry.' }, { status: 503 }); }
  },
} } });
