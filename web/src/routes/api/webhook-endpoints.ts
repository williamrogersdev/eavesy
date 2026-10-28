import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { isRecord } from '@/lib/json';
import { resolveActor } from '@/server/auth';
import {
  WebhookInputError,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  listWebhookEndpoints,
  updateWebhookEndpoint,
} from '@/server/webhooks';

const unauthenticated = () => Response.json({ error: 'unauthenticated' }, { status: 401 });
const notFound = () => Response.json({ error: 'not found' }, { status: 404 });

async function signedIn() {
  try {
    return await resolveActor();
  } catch {
    return null;
  }
}

/** Settings → Webhooks. The same operations as /v1/webhooks on the API, for the signed-in browser. */
export const Route = createFileRoute('/api/webhook-endpoints')({
  server: {
    handlers: {
      GET: async () => {
        const actor = await signedIn();
        if (!actor) return unauthenticated();
        return Response.json(await listWebhookEndpoints(getDb(), actor.userId));
      },
      POST: async ({ request }) => {
        const actor = await signedIn();
        if (!actor) return unauthenticated();
        try {
          return Response.json(await createWebhookEndpoint(getDb(), actor.userId, await request.json().catch(() => null)), { status: 201 });
        } catch (error) {
          if (error instanceof WebhookInputError) return Response.json({ error: error.message }, { status: 400 });
          throw error;
        }
      },
      PATCH: async ({ request }) => {
        const actor = await signedIn();
        if (!actor) return unauthenticated();
        const body: unknown = await request.json().catch(() => null);
        if (!isRecord(body) || typeof body.id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
        const { id, ...changes } = body;
        try {
          const view = await updateWebhookEndpoint(getDb(), actor.userId, id, changes);
          return view ? Response.json(view) : notFound();
        } catch (error) {
          if (error instanceof WebhookInputError) return Response.json({ error: error.message }, { status: 400 });
          throw error;
        }
      },
      DELETE: async ({ request }) => {
        const actor = await signedIn();
        if (!actor) return unauthenticated();
        const body: unknown = await request.json().catch(() => null);
        if (!isRecord(body) || typeof body.id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
        return (await deleteWebhookEndpoint(getDb(), actor.userId, body.id)) ? Response.json({ ok: true }) : notFound();
      },
    },
  },
});
