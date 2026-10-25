import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota, refundSpend, refundUserQuota } from '@/server/rate-limit';
import { MAX_CONSOLIDATE_BYTES, consolidateInput, readJson, respond, runConsolidate } from '@/server/assistant';

/** Merges Eavesy's notes into fewer when memory.md is full (assistant.md H1). The Mac keeps a backup and checks the result. */
export const Route = createFileRoute('/api/assistant/consolidate')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in to use Eavesy.' }, { status: 401 }); }
    const input = await readJson(request, consolidateInput, MAX_CONSOLIDATE_BYTES);
    if (input instanceof Response) return input;
    const chargedAt = Date.now();
    const quota = await guardUserQuota(actor.userId, 'assistant', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'assistant', { perMin: 60, perDay: 20_000 });
    if (limited) { await refundUserQuota(actor.userId, 'assistant', chargedAt); return limited; }
    return respond(() => runConsolidate(anthropic(), input), async () => {
      await Promise.allSettled([refundUserQuota(actor.userId, 'assistant', chargedAt), refundSpend('assistant', chargedAt)]);
    });
  },
} } });
