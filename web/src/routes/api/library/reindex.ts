import { createFileRoute } from '@tanstack/react-router';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { resolveActor } from '@/server/auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import type { ProcessingEnv } from '@/server/processing-worker';
import { creditsConfigured } from '@/lib/ai/credit-runner';
export const Route = createFileRoute('/api/library/reindex')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveActor(); } catch { return Response.json({ error: 'unauthenticated' }, { status: 401 }); }
    if (actor.isAnonymous) return Response.json({ error: 'Sign in to index your library' }, { status: 403 });
    const env = getCloudflareContext<ProcessingEnv>().env;
    if (!creditsConfigured(env) || env.AI_CREDITS_PAUSED === 'true') return Response.json({ error: 'Credit processing is not enabled.' }, { status: 503 });
    const parsed = z.object({ cursor: z.string().max(200).optional() }).safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'Invalid cursor' }, { status: 400 });
    const rows = await getDb().select({ id: meetings.id }).from(meetings)
      .where(and(eq(meetings.userId, actor.userId), eq(meetings.status, 'complete'), isNull(meetings.deletedAt), parsed.data.cursor ? gt(meetings.id, parsed.data.cursor) : undefined))
      .orderBy(asc(meetings.id)).limit(51);
    const batch = rows.slice(0, 50);
    for (const row of batch) await env.PROCESSING_QUEUE.send({ kind: 'embed', meetingId: row.id });
    return Response.json({ queued: batch.length, cursor: rows.length > 50 ? batch.at(-1)?.id : null });
  },
} } });
