import { eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { userNotes } from '../schema';

export async function upsert(db: AppDb, args: { meetingId: string; contentMd: string }) {
  const existing = await db
    .select()
    .from(userNotes)
    .where(eq(userNotes.meetingId, args.meetingId))
    .limit(1);
  const now = Date.now();
  if (existing[0]) {
    await db
      .update(userNotes)
      .set({ contentMd: args.contentMd, updatedAt: now })
      .where(eq(userNotes.meetingId, args.meetingId));
    return existing[0].meetingId;
  }
  await db
    .insert(userNotes)
    .values({ meetingId: args.meetingId, contentMd: args.contentMd, updatedAt: now });
  return args.meetingId;
}

export async function get(db: AppDb, meetingId: string) {
  const rows = await db
    .select()
    .from(userNotes)
    .where(eq(userNotes.meetingId, meetingId))
    .limit(1);
  return rows[0] ?? null;
}
