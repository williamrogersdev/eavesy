import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';
import { agentReplyRequest } from '@/server/agent-reply';

export const Route = createFileRoute('/api/agents/reply-suggestion')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in or connect your Eavesy account to get reply suggestions.' }, { status: 401 }); }
    const quota = await guardUserQuota(actor.userId, 'agent-reply');
    if (quota) return quota;
    const limited = await guardSpend(request, 'agent-reply', { perMin: 30, perDay: 5000 });
    if (limited) return limited;
    return agentReplyRequest(request, anthropic);
  },
} } });
