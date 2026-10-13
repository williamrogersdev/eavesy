import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { dictations } from '../schema';

export async function create(
  db: AppDb,
  args: {
    userId: string;
    title: string;
    transcript: string;
    cleanedText?: string;
    appliedTemplateId?: string;
    targetApp?: string;
    durationSec: number;
    audioR2Key?: string;
    localFolderSlug?: string;
  },
): Promise<string> {
  const id = pid('dict');
  await db.insert(dictations).values({
    id,
    userId: args.userId,
    title: args.title,
    transcript: args.transcript,
    cleanedText: args.cleanedText,
    appliedTemplateId: args.appliedTemplateId,
    targetApp: args.targetApp,
    durationSec: args.durationSec,
    audioR2Key: args.audioR2Key,
    localFolderSlug: args.localFolderSlug,
    createdAt: Date.now(),
  });
  return id;
}

export async function listForUser(db: AppDb, args: { userId: string; limit?: number }) {
  return await db
    .select()
    .from(dictations)
    .where(and(eq(dictations.userId, args.userId), isNull(dictations.deletedAt)))
    .orderBy(desc(dictations.createdAt))
    .limit(args.limit ?? 50);
}

export async function get(db: AppDb, args: { userId: string; id: string }) {
  const rows = await db
    .select()
    .from(dictations)
    .where(
      and(
        eq(dictations.id, args.id),
        eq(dictations.userId, args.userId),
        isNull(dictations.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function softDelete(db: AppDb, args: { userId: string; id: string }) {
  await db
    .update(dictations)
    .set({ deletedAt: Date.now() })
    .where(and(eq(dictations.id, args.id), eq(dictations.userId, args.userId)));
}
