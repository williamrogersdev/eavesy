/**
 * Transcript segment repository.
 *
 * Per SPEC §7.6 segments are appended during a recording as partials
 * (`isFinal=false`) and replaced with the final version once a streaming engine
 * finalizes them. To avoid O(n) re-renders we coalesce partials that
 * share a `startMs`.
 */
import { and, asc, desc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { transcriptSegments, meetings } from '../schema';
import { remember } from './dictionary';
import { learnCorrections } from '@/lib/dictionary/learning';

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
  // If the last segment is still a partial and shares the same startMs,
  // we update in place. This keeps the segment count proportional to the
  // number of *final* phrases, not the number of WebSocket frames.
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
  args: { userId: string; meetingId: string; segmentId: string; text?: string; speakerId?: string },
) {
  const original = (await db.select({ line: transcriptSegments }).from(transcriptSegments)
    .innerJoin(meetings, eq(meetings.id, transcriptSegments.meetingId)).where(and(
      eq(meetings.userId, args.userId), eq(transcriptSegments.meetingId, args.meetingId), eq(transcriptSegments.id, args.segmentId),
    )).limit(1))[0]?.line;
  if (!original) return false;
  const patch: Partial<typeof transcriptSegments.$inferInsert> = { isEdited: true, rawText: original.rawText ?? original.text };
  if (args.text !== undefined) await remember(db, args.userId, learnCorrections(original.text, args.text), 'learned');
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
  return true;
}

/**
 * Rename a speaker retroactively across every segment of a meeting.
 * Used by the speaker labeling UI (SPEC §7.5).
 */
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

/** Delete one line, returning it so the caller can offer undo. */
export async function deleteSegment(db: AppDb, args: { meetingId: string; segmentId: string }) {
  const deleted = await db
    .delete(transcriptSegments)
    .where(
      and(eq(transcriptSegments.id, args.segmentId), eq(transcriptSegments.meetingId, args.meetingId)),
    )
    .returning();
  return deleted[0] ?? null;
}

/** Put a deleted line back exactly as it was (undo). */
export async function restoreSegment(db: AppDb, segment: Segment) {
  await db.insert(transcriptSegments).values(segment).onConflictDoNothing();
}
