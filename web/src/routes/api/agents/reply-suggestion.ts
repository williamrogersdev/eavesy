import { createFileRoute } from '@tanstack/react-router';
import { resolveIngestActor } from '@/server/device-auth';
import { anthropic } from '@/lib/ai/client';
import { guardSpend, guardUserQuota, refundUserQuota } from '@/server/rate-limit';
import { agentReplyResponse, readAgentReplyRequest } from '@/server/agent-reply';

export const Route = createFileRoute('/api/agents/reply-suggestion')({ server: { handlers: {
  POST: async ({ request }) => {
    let actor;
    try { actor = await resolveIngestActor(request); }
    catch { return Response.json({ error: 'Sign in or connect your Eavesy account to get reply suggestions.' }, { status: 401 }); }
    // Validate first so a bad request never costs the user a daily use.
    const input = await readAgentReplyRequest(request);
    if (input instanceof Response) return input;
    const chargedAt = Date.now();
    const refund = () => refundUserQuota(actor.userId, 'agent-reply', chargedAt);
    const quota = await guardUserQuota(actor.userId, 'agent-reply', chargedAt);
    if (quota) return quota;
    const limited = await guardSpend(request, 'agent-reply', { perMin: 30, perDay: 5000 });
    if (limited) { await refund(); return limited; }
    return agentReplyResponse(input, anthropic, refund);
  },
} } });
