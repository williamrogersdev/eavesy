import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota, refundSpend, refundUserQuota } from '@/server/rate-limit';
import { MAX_TURN_BYTES, readJson, respond, runTurn, turnInput } from '@/server/assistant';

/** One step of Eavesy's conversation for the Mac app: text and tool calls back. */
export const Route = createFileRoute('/api/assistant/turn')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in to talk to Eavesy.' }, { status: 401 }); }
    const input = await readJson(request, turnInput, MAX_TURN_BYTES);
    if (input instanceof Response) return input;
    const chargedAt = Date.now();
    const quota = await guardUserQuota(actor.userId, 'assistant', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'assistant', { perMin: 60, perDay: 20_000 });
    if (limited) { await refundUserQuota(actor.userId, 'assistant', chargedAt); return limited; }
    return respond(() => runTurn(anthropic(), input), async () => {
      await Promise.allSettled([refundUserQuota(actor.userId, 'assistant', chargedAt), refundSpend('assistant', chargedAt)]);
    });
  },
} } });
