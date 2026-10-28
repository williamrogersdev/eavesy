import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { isRecord } from '@/lib/json';
import { resolveActor } from '@/server/auth';
import { testWebhookEndpoint } from '@/server/webhooks';

export const Route = createFileRoute('/api/webhook-endpoints/test')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const body: unknown = await request.json().catch(() => null);
        if (!isRecord(body) || typeof body.id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
        const result = await testWebhookEndpoint(getDb(), actor.userId, body.id);
        return result ? Response.json(result) : Response.json({ error: 'not found' }, { status: 404 });
      },
    },
  },
});
