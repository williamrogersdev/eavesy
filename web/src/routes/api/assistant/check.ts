import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota, refundSpend, refundUserQuota } from '@/server/rate-limit';
import { MAX_CHECK_BYTES, checkInput, readJson, respond, runCheck } from '@/server/assistant';

/** The second-model check (assistant.md C7): does this action match what you literally asked? A failure here is a card on the Mac. */
export const Route = createFileRoute('/api/assistant/check')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in to use Eavesy.' }, { status: 401 }); }
    const input = await readJson(request, checkInput, MAX_CHECK_BYTES);
    if (input instanceof Response) return input;
    const chargedAt = Date.now();
    const quota = await guardUserQuota(actor.userId, 'assistant', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'assistant', { perMin: 60, perDay: 20_000 });
    if (limited) { await refundUserQuota(actor.userId, 'assistant', chargedAt); return limited; }
    return respond(() => runCheck(anthropic(), input), async () => {
      await Promise.allSettled([refundUserQuota(actor.userId, 'assistant', chargedAt), refundSpend('assistant', chargedAt)]);
    });
  },
} } });
