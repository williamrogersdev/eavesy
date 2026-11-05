import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { turnOffRecapsByToken } from '@/server/email/recaps';
import { clientIp, guardBurst } from '@/server/rate-limit';

const bodySchema = z.object({ token: z.string().max(128) });

/**
 * The one-click "turn off recaps" link in a recap. The link opens a page; only
 * its button POSTs here, so a mail scanner following the link changes nothing.
 * The token is the account's secret `email_recaps_off_token`.
 */
export const Route = createFileRoute('/api/email/recaps-off')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const limited = await guardBurst(clientIp(request), 'recaps-off');
        if (limited) return limited;
        const parsed = bodySchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const ok = await turnOffRecapsByToken(getDb(), parsed.data.token);
        if (!ok) return Response.json({ error: 'not_found' }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
