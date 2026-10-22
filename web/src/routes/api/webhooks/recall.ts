import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { type BotEnv, handleWebhook } from '@/server/meeting-bots/service';
import { reportError } from '@/server/observability';

/** Recall.ai bot status webhooks. Authenticated by signature, not by a session. */
export const Route = createFileRoute('/api/webhooks/recall')({ server: { handlers: {
  POST: async ({ request }) => {
    try { return await handleWebhook(getDb(), getCloudflareContext<BotEnv>().env, request); }
    catch (error) {
      // Recall retries non-2xx deliveries for a day, so a transient failure isn't lost.
      reportError('recall webhook failed', error);
      return Response.json({ error: 'webhook_failed' }, { status: 503 });
    }
  },
} } });
