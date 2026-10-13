import { and, asc, desc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { transcriptSegments } from '../schema';

export type Segment = typeof transcriptSegments.$inferSelect;

export async function appendOrCoalesce(
  db: AppDb,
  args: {
    meetingId: string;
    startMs: number;
    endMs: number;
    speakerId?: string;
    text: string;
    confidence?: number;
    isFinal: boolean;
  },
): Promise<string> {
  const last = await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, args.meetingId))
    .orderBy(desc(transcriptSegments.startMs))
    .limit(1);

  if (last[0] && !last[0].isFinal && last[0].startMs === args.startMs) {
    await db
      .update(transcriptSegments)
      .set({
        endMs: args.endMs,
        text: args.text,
        speakerId: args.speakerId ?? last[0].speakerId,
        confidence: args.confidence ?? last[0].confidence,
        isFinal: args.isFinal,
      })
      .where(eq(transcriptSegments.id, last[0].id));
    return last[0].id;
  }

  const id = pid('seg');
  await db.insert(transcriptSegments).values({
    id,
    meetingId: args.meetingId,
    startMs: args.startMs,
    endMs: args.endMs,
    speakerId: args.speakerId,
    text: args.text,
    confidence: args.confidence,
    isEdited: false,
    isFinal: args.isFinal,
  });
  return id;
}

export async function listForMeeting(db: AppDb, meetingId: string): Promise<Segment[]> {
  return await db
    .select()
    .from(transcriptSegments)
    .where(eq(transcriptSegments.meetingId, meetingId))
    .orderBy(asc(transcriptSegments.startMs));
}

export async function editSegment(
  db: AppDb,
  args: { meetingId: string; segmentId: string; text?: string; speakerId?: string },
) {
  const patch: Partial<typeof transcriptSegments.$inferInsert> = { isEdited: true };
  if (args.text !== undefined) patch.text = args.text;
  if (args.speakerId !== undefined) patch.speakerId = args.speakerId;
  await db
    .update(transcriptSegments)
    .set(patch)
    .where(
      and(
        eq(transcriptSegments.id, args.segmentId),
        eq(transcriptSegments.meetingId, args.meetingId),
      ),
    );
}

export async function renameSpeakerInMeeting(
  db: AppDb,
  args: { meetingId: string; oldSpeakerId: string; newSpeakerId: string },
) {
  await db
    .update(transcriptSegments)
    .set({ speakerId: args.newSpeakerId })
    .where(
      and(
        eq(transcriptSegments.meetingId, args.meetingId),
        eq(transcriptSegments.speakerId, args.oldSpeakerId),
      ),
    );
}

export async function deleteSegment(db: AppDb, args: { meetingId: string; segmentId: string }) {
  const deleted = await db
    .delete(transcriptSegments)
    .where(
      and(eq(transcriptSegments.id, args.segmentId), eq(transcriptSegments.meetingId, args.meetingId)),
    )
    .returning();
  return deleted[0] ?? null;
}

export async function restoreSegment(db: AppDb, segment: Segment) {
  await db.insert(transcriptSegments).values(segment).onConflictDoNothing();
}
