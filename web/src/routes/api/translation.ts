import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { createAiRunner, type CreditEnv } from '@/lib/ai/credit-runner';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';
import { translationRequest } from '@/server/translation';

export const Route = createFileRoute('/api/translation')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in or connect your Eavesy account to translate.' }, { status: 401 }); }
    const quota = await guardUserQuota(actor.userId, 'translate');
    if (quota) return quota;
    const limited = await guardSpend(request, 'translation', { perMin: 20, perDay: 5000 });
    if (limited) return limited;
    return translationRequest(request, createAiRunner(getCloudflareContext().env as unknown as CreditEnv, 'translation'));
  },
} } });
