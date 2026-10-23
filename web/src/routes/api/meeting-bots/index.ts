import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { type BotEnv, botsAvailable, listBots, scheduleBot } from '@/server/meeting-bots/service';
import { guardBurst, guardUserQuota } from '@/server/rate-limit';

export const Route = createFileRoute('/api/meeting-bots/')({ server: { handlers: {
  GET: async () => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    const env = getCloudflareContext<BotEnv>().env;
    return Response.json({ available: botsAvailable(env), bots: await listBots(getDb(), actor.userId) });
  },
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    const limited = await guardBurst(actor.userId, 'meeting-bot');
    if (limited) return limited;
    // Each bot is a recorded, transcribed and summarized meeting: it spends the processing budget.
    const quota = await guardUserQuota(actor.userId, 'process');
    if (quota) return quota;
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: 'Invalid request body' }, { status: 400 }); }
    try { return await scheduleBot(getDb(), getCloudflareContext<BotEnv>().env, actor.userId, body); }
    catch { return Response.json({ error: 'The notetaker could not be scheduled. Please retry.' }, { status: 503 }); }
  },
} } });
