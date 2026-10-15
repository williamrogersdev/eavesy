import { and, desc, eq, gt } from 'drizzle-orm';
import type { AppDb } from '../client';
import { drops } from '../schema';

export type Drop = typeof drops.$inferSelect;

// The processing worker's daily purge hard-deletes drops older than this.
export const DROP_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export async function create(db: AppDb, row: Drop): Promise<void> {
  await db.insert(drops).values(row);
}

export async function listForUser(
  db: AppDb,
  args: { userId: string; limit: number; now?: number },
): Promise<Drop[]> {
  const cutoff = (args.now ?? Date.now()) - DROP_TTL_MS;
  return await db
    .select()
    .from(drops)
    .where(and(eq(drops.userId, args.userId), gt(drops.createdAt, cutoff)))
    .orderBy(desc(drops.createdAt))
    .limit(args.limit);
}

export async function get(db: AppDb, args: { dropId: string; userId: string }): Promise<Drop | null> {
  const [row] = await db
    .select()
    .from(drops)
    .where(and(eq(drops.id, args.dropId), eq(drops.userId, args.userId)))
    .limit(1);
  return row ?? null;
}

export async function remove(db: AppDb, args: { dropId: string; userId: string }): Promise<void> {
  await db.delete(drops).where(and(eq(drops.id, args.dropId), eq(drops.userId, args.userId)));
}
