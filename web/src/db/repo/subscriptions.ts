import { eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { subscriptions } from '../schema';
import type { PlanId } from '@/lib/plans';

export type SubscriptionRow = typeof subscriptions.$inferSelect;

export async function getByUserId(db: AppDb, userId: string): Promise<SubscriptionRow | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getByCustomerId(
  db: AppDb,
  stripeCustomerId: string,
): Promise<SubscriptionRow | null> {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return rows[0] ?? null;
}

export async function ensure(db: AppDb, userId: string): Promise<SubscriptionRow> {
  const existing = await getByUserId(db, userId);
  if (existing) return existing;
  const now = Date.now();
  const id = pid('sub');
  await db.insert(subscriptions).values({
    id,
    userId,
    plan: 'free',
    status: 'none',
    seats: 1,
    createdAt: now,
    updatedAt: now,
  });
  return (await getByUserId(db, userId))!;
}

export async function setFreePlan(db: AppDb, userId: string): Promise<void> {
  await ensure(db, userId);
  await db
    .update(subscriptions)
    .set({ plan: 'free', status: 'active', updatedAt: Date.now() })
    .where(eq(subscriptions.userId, userId));
}

export async function setStripeCustomerId(
  db: AppDb,
  userId: string,
  stripeCustomerId: string,
): Promise<void> {
  await ensure(db, userId);
  await db
    .update(subscriptions)
    .set({ stripeCustomerId, updatedAt: Date.now() })
    .where(eq(subscriptions.userId, userId));
}

export interface StripeSubscriptionPatch {
  userId: string;
  plan: PlanId;
  status: SubscriptionRow['status'];
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  stripePriceId?: string | null;
  seats?: number;
  currentPeriodEnd?: number | null;
}

export async function upsertFromStripe(db: AppDb, patch: StripeSubscriptionPatch): Promise<void> {
  await ensure(db, patch.userId);
  await db
    .update(subscriptions)
    .set({
      plan: patch.plan,
      status: patch.status,
      ...(patch.stripeCustomerId !== undefined ? { stripeCustomerId: patch.stripeCustomerId } : {}),
      ...(patch.stripeSubscriptionId !== undefined
        ? { stripeSubscriptionId: patch.stripeSubscriptionId }
        : {}),
      ...(patch.stripePriceId !== undefined ? { stripePriceId: patch.stripePriceId } : {}),
      ...(patch.seats !== undefined ? { seats: patch.seats } : {}),
      ...(patch.currentPeriodEnd !== undefined ? { currentPeriodEnd: patch.currentPeriodEnd } : {}),
      updatedAt: Date.now(),
    })
    .where(eq(subscriptions.userId, patch.userId));
}
