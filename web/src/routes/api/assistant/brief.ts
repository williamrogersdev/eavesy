import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota, refundSpend, refundUserQuota } from '@/server/rate-limit';
import { MAX_BRIEF_BYTES, briefInput, readJson, respond, runBrief } from '@/server/assistant';

/** Writes the brief of a conversation (macro-awareness.md P). Nothing is stored here: the Mac keeps the brief. */
export const Route = createFileRoute('/api/assistant/brief')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in to use Eavesy.' }, { status: 401 }); }
    const input = await readJson(request, briefInput, MAX_BRIEF_BYTES);
    if (input instanceof Response) return input;
    const chargedAt = Date.now();
    const quota = await guardUserQuota(actor.userId, 'assistant', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'assistant', { perMin: 60, perDay: 20_000 });
    if (limited) { await refundUserQuota(actor.userId, 'assistant', chargedAt); return limited; }
    return respond(async () => runBrief(anthropic(), input), async () => {
      await Promise.allSettled([refundUserQuota(actor.userId, 'assistant', chargedAt), refundSpend('assistant', chargedAt)]);
    });
  },
} } });
