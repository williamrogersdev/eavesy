import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { handleEmailWebhook } from '@/server/email/recaps';
import type { EmailEnv } from '@/server/email/resend';
import { reportError } from '@/server/observability';

/** Resend delivery webhooks for email recaps. Authenticated by signature, not by a session. */
export const Route = createFileRoute('/api/webhooks/resend')({ server: { handlers: {
  POST: async ({ request }) => {
    try { return await handleEmailWebhook(getDb(), getCloudflareContext<EmailEnv>().env, request); }
    catch (error) {
      // Resend retries non-2xx deliveries, so a transient failure isn't lost.
      reportError('resend webhook failed', error);
      return Response.json({ error: 'webhook_failed' }, { status: 503 });
    }
  },
} } });
