import { createFileRoute } from '@tanstack/react-router';
import type Stripe from 'stripe';
import { getDb } from '@/db/client';
import { getStripe, verifyStripeWebhook } from '@/lib/stripe';
import { finalizeSubscription } from '@/server/billing';

export const Route = createFileRoute('/api/webhooks/stripe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const signature = request.headers.get('stripe-signature');
        if (!signature) {
          return Response.json({ error: 'missing signature' }, { status: 400 });
        }

        const payload = await request.text();
        let event: Stripe.Event;
        try {
          event = await verifyStripeWebhook(payload, signature);
        } catch (err) {
          console.error('stripe webhook signature verification failed', err);
          return Response.json({ error: 'invalid signature' }, { status: 400 });
        }

        const db = getDb();
        const stripe = getStripe();

        try {
          switch (event.type) {
            case 'checkout.session.completed': {
              const session = event.data.object;
              if (session.mode === 'subscription' && session.subscription) {
                const subId =
                  typeof session.subscription === 'string'
                    ? session.subscription
                    : session.subscription.id;
                const sub = await stripe.subscriptions.retrieve(subId);
                if (!sub.metadata?.userId && session.metadata?.userId) {
                  sub.metadata = { ...sub.metadata, userId: session.metadata.userId };
                }
                await finalizeSubscription(db, sub);
              }
              break;
            }
            case 'customer.subscription.created':
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': {
              const sub = event.data.object;
              await finalizeSubscription(db, sub);
              break;
            }
            default:
              break;
          }
        } catch (err) {
          console.error(`stripe webhook handler error for ${event.type}`, err);
          return Response.json({ error: 'handler error' }, { status: 500 });
        }

        return Response.json({ received: true });
      },
    },
  },
});
