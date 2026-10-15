import { and, eq, gt, gte, lte, or } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetingSegments, transcriptSegments } from '@/db/schema';
import { mergeRanges, type TranscriptRange } from '@/lib/transcription/live-transcript';
import { ECHO_WINDOW_MS } from '@/lib/transcription/two-track';

/**
 * Segment stamps come from whichever processing isolate finished the segment,
 * so a stamp can land slightly behind a cursor already handed out. Segments
 * stamped this far behind the cursor are looked at again, but only sent when
 * the caller has not seen them (see `transcriptDelta`).
 */
export const CURSOR_OVERLAP_MS = 30_000;

export type TranscriptLine = typeof transcriptSegments.$inferSelect;

/**
 * Transcript changes since `since`, as whole time ranges: `lines` is every line
 * now inside `ranges`, and a client replaces whatever it holds in those ranges
 * with them. Echo removal deletes lines, so new lines alone could not say what
 * to drop. `cursor` is what to pass as `since` next time.
 */
export interface TranscriptDelta {
  cursor: number;
  ranges: TranscriptRange[];
  lines: TranscriptLine[];
}

/** Identifies one transcription of one segment; a re-transcription gets a new key. */
export type SegmentStamp = string;

/**
 * Changes since `since`. A stream passes the stamps it already sent in `sent`
 * and gets only segments it has not sent, including one whose stamp landed
 * behind the cursor. A stateless poll (no `sent`) gets nothing unless some
 * segment is newer than its cursor, so polling an idle meeting sends nothing;
 * a stamp that landed behind the cursor comes along with the next new one.
 */
export async function transcriptDelta(
  db: AppDb,
  meetingId: string,
  since: number,
  sent?: Set<SegmentStamp>,
): Promise<TranscriptDelta & { stamps: SegmentStamp[] }> {
  const touched = await db
    .select({
      id: meetingSegments.id,
      offsetMs: meetingSegments.offsetMs,
      durationMs: meetingSegments.durationMs,
      transcribedAt: meetingSegments.transcribedAt,
    })
    .from(meetingSegments)
    .where(
      and(
        eq(meetingSegments.meetingId, meetingId),
        gt(meetingSegments.transcribedAt, Math.max(0, since - CURSOR_OVERLAP_MS)),
      ),
    );
  const stampOf = (row: (typeof touched)[number]) => `${row.id}@${row.transcribedAt}`;
  const fresh = sent
    ? touched.filter((row) => !sent.has(stampOf(row)))
    : touched.some((row) => (row.transcribedAt ?? 0) > since)
      ? touched
      : [];
  if (fresh.length === 0) return { cursor: since, ranges: [], lines: [], stamps: [] };

  const cursor = touched.reduce((latest, row) => Math.max(latest, row.transcribedAt ?? 0), since);
  // Echo removal for a segment reaches this far either side of it.
  const ranges = mergeRanges(
    fresh.map((row) => ({
      fromMs: Math.max(0, row.offsetMs - ECHO_WINDOW_MS),
      toMs: row.offsetMs + row.durationMs + ECHO_WINDOW_MS,
    })),
  );
  const lines = await db
    .select()
    .from(transcriptSegments)
    .where(
      and(
        eq(transcriptSegments.meetingId, meetingId),
        or(
          ...ranges.map((range) =>
            and(gte(transcriptSegments.endMs, range.fromMs), lte(transcriptSegments.startMs, range.toMs)),
          ),
        ),
      ),
    )
    .orderBy(transcriptSegments.startMs);
  return { cursor, ranges, lines, stamps: fresh.map(stampOf) };
}
