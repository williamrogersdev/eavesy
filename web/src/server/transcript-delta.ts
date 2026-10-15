import { and, eq, gt, gte, lte, or } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { meetingSegments, transcriptSegments } from '@/db/schema';
import { mergeRanges, type TranscriptRange } from '@/lib/transcription/live-transcript';
import { ECHO_WINDOW_MS } from '@/lib/transcription/two-track';

/**
 * Segment stamps come from whichever processing isolate finished the segment,
 * so a stamp can land slightly behind a cursor already handed out. Rereading
 * this far back costs a few repeated ranges, which clients apply idempotently.
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

export async function transcriptDelta(db: AppDb, meetingId: string, since: number): Promise<TranscriptDelta> {
  const touched = await db
    .select({
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
  if (touched.length === 0) return { cursor: since, ranges: [], lines: [] };

  const cursor = touched.reduce((latest, row) => Math.max(latest, row.transcribedAt ?? 0), since);
  // Echo removal for a segment reaches this far either side of it.
  const ranges = mergeRanges(
    touched.map((row) => ({
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
  return { cursor, ranges, lines };
}
