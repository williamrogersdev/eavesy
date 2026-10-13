import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as subsRepo from '@/db/repo/subscriptions';
import { resolveActor } from '@/server/auth';
import { getStripe } from '@/lib/stripe';

export const Route = createFileRoute('/api/billing/portal')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const db = getDb();
        const sub = await subsRepo.getByUserId(db, actor.userId);
        if (!sub?.stripeCustomerId) {
          return Response.json({ error: 'no_subscription' }, { status: 400 });
        }

        const origin = new URL(request.url).origin;
        const session = await getStripe().billingPortal.sessions.create({
          customer: sub.stripeCustomerId,
          return_url: `${origin}/app/settings`,
        });
        return Response.json({ url: session.url });
      },
    },
  },
});
