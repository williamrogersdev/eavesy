import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import * as subsRepo from '@/db/repo/subscriptions';
import { resolveActor } from '@/server/auth';
import { getStripe, stripePriceIdFor } from '@/lib/stripe';

const schema = z.object({ plan: z.enum(['pro', 'team']) });

export const Route = createFileRoute('/api/billing/checkout')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsedBody = schema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const { plan } = parsedBody.data;
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const priceId = stripePriceIdFor(plan);
        if (!priceId) {
          return Response.json(
            { error: `No Stripe price configured for the ${plan} plan` },
            { status: 400 },
          );
        }

        const db = getDb();
        const u = (await db.select().from(users).where(eq(users.id, actor.userId)).limit(1))[0];
        if (!u) return Response.json({ error: 'not found' }, { status: 404 });

        const stripe = getStripe();
        const sub = await subsRepo.ensure(db, actor.userId);

        let customerId = sub.stripeCustomerId ?? undefined;
        if (!customerId) {
          const customer = await stripe.customers.create({
            email: u.email ?? undefined,
            name: u.displayName ?? undefined,
            metadata: { userId: actor.userId },
          });
          customerId = customer.id;
          await subsRepo.setStripeCustomerId(db, actor.userId, customerId);
        }

        const origin = new URL(request.url).origin;
        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          client_reference_id: actor.userId,
          line_items: [{ price: priceId, quantity: 1 }],
          allow_promotion_codes: true,
          success_url: `${origin}/onboarding/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/onboarding?step=plan`,
          metadata: { userId: actor.userId, plan },
          subscription_data: { metadata: { userId: actor.userId, plan } },
        });

        if (!session.url) {
          return Response.json({ error: 'Failed to create checkout session' }, { status: 502 });
        }
        return Response.json({ url: session.url });
      },
    },
  },
});
