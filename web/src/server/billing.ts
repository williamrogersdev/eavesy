import type Stripe from 'stripe';
import type { AppDb } from '@/db/client';
import * as subsRepo from '@/db/repo/subscriptions';
import * as usersRepo from '@/db/repo/users';
import { planIdForPriceId } from '@/lib/stripe';
import type { SubscriptionRow } from '@/db/repo/subscriptions';

function mapStatus(stripeStatus: Stripe.Subscription.Status): SubscriptionRow['status'] {
  switch (stripeStatus) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'paused':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null);
}

async function resolveUserId(db: AppDb, sub: Stripe.Subscription): Promise<string | null> {
  const fromMeta = sub.metadata?.userId;
  if (fromMeta) return fromMeta;
  const customerId = customerIdOf(sub);
  if (customerId) {
    const row = await subsRepo.getByCustomerId(db, customerId);
    if (row) return row.userId;
  }
  return null;
}

export async function finalizeSubscription(
  db: AppDb,
  sub: Stripe.Subscription,
): Promise<string | null> {
  const userId = await resolveUserId(db, sub);
  if (!userId) return null;

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const seats = item?.quantity ?? 1;
  const periodEndSec =
    (item as unknown as { current_period_end?: number })?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    null;

  await subsRepo.upsertFromStripe(db, {
    userId,
    plan: planIdForPriceId(priceId),
    status: mapStatus(sub.status),
    stripeCustomerId: customerIdOf(sub),
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    seats,
    currentPeriodEnd: periodEndSec ? periodEndSec * 1000 : null,
  });

  if (sub.status === 'active' || sub.status === 'trialing') {
    await usersRepo.markOnboarded(db, userId);
  }
  return userId;
}
