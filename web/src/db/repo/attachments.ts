import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetingAttachments } from '@/db/schema';
import { mediaProxyUrl } from '@/server/r2';

/**
 * Pictures attached to meetings (Snapshots of shared screens, screenshots).
 * The shape is documented in docs/MEETING-ATTACHMENTS.md; the vision step
 * reads `listUncaptioned` and writes back with `setCaption`.
 */
export type MeetingAttachmentRow = typeof meetingAttachments.$inferSelect;

/** What the meeting page and exports see. */
export interface MeetingAttachmentView {
  id: string;
  kind: 'snapshot' | 'screenshot';
  offsetMs: number;
  url: string;
  width: number | null;
  height: number | null;
  caption: string | null;
}

export function toView(row: MeetingAttachmentRow): MeetingAttachmentView {
  return {
    id: row.id,
    kind: row.kind,
    offsetMs: row.offsetMs,
    url: mediaProxyUrl(row.r2Key),
    width: row.width,
    height: row.height,
    caption: row.caption,
  };
}

export function listForMeetingQuery(db: AppDb, meetingId: string) {
  return db
    .select()
    .from(meetingAttachments)
    .where(eq(meetingAttachments.meetingId, meetingId))
    .orderBy(asc(meetingAttachments.offsetMs), asc(meetingAttachments.clientName));
}

/** A meeting's pictures in the order they were taken. */
export async function listForMeeting(db: AppDb, meetingId: string): Promise<MeetingAttachmentRow[]> {
  return await listForMeetingQuery(db, meetingId);
}

/** Pictures still waiting for a caption, oldest first; for the vision step. */
export async function listUncaptioned(db: AppDb, opts: { meetingId?: string; limit?: number } = {}) {
  return await db
    .select()
    .from(meetingAttachments)
    .where(
      and(
        isNull(meetingAttachments.captionedAt),
        opts.meetingId ? eq(meetingAttachments.meetingId, opts.meetingId) : undefined,
      ),
    )
    .orderBy(asc(meetingAttachments.createdAt))
    .limit(opts.limit ?? 50);
}

export async function setCaption(
  db: AppDb,
  args: { id: string; caption: string; model: string; at?: number },
): Promise<void> {
  await db
    .update(meetingAttachments)
    .set({ caption: args.caption, captionModel: args.model, captionedAt: args.at ?? Date.now() })
    .where(eq(meetingAttachments.id, args.id));
}
