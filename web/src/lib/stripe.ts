import Stripe from 'stripe';
import { requireServerEnv, serverEnv } from './env';
import type { PlanId } from './plans';

let cached: Stripe | null = null;

export function stripePriceIdFor(id: PlanId): string | undefined {
  if (id === 'pro') return serverEnv.STRIPE_PRICE_PRO;
  if (id === 'team') return serverEnv.STRIPE_PRICE_TEAM;
  return undefined;
}

export function planIdForPriceId(priceId: string | null | undefined): PlanId {
  if (priceId && priceId === serverEnv.STRIPE_PRICE_TEAM) return 'team';
  if (priceId && priceId === serverEnv.STRIPE_PRICE_PRO) return 'pro';
  return 'free';
}

export function getStripe(): Stripe {
  if (cached) return cached;
  cached = new Stripe(requireServerEnv('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return cached;
}

export async function verifyStripeWebhook(
  payload: string,
  signature: string,
): Promise<Stripe.Event> {
  const stripe = getStripe();
  return stripe.webhooks.constructEventAsync(
    payload,
    signature,
    requireServerEnv('STRIPE_WEBHOOK_SECRET'),
    undefined,
    Stripe.createSubtleCryptoProvider(),
  );
}
