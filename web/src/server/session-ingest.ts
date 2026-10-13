import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetings } from '@/db/schema';
import type { ResolvedIngestActor } from '@/server/device-auth';

export const ARCHIVE_PART_SIZE = 8 * 1024 * 1024;
export const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;

export async function ownedMeeting(
  db: AppDb,
  meetingId: string,
  actor: ResolvedIngestActor,
) {
  return (
    await db
      .select()
      .from(meetings)
      // A deleted meeting stops accepting uploads (and the paid processing
      // they trigger); the Mac treats the 404 as final.
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, actor.userId), isNull(meetings.deletedAt)))
      .limit(1)
  )[0];
}

export function boundedInteger(
  value: string | null | undefined,
  opts: { min: number; max: number },
): number | null {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < opts.min || parsed > opts.max) return null;
  return parsed;
}
