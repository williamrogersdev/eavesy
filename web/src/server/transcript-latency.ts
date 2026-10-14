import { and, eq, isNull } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type * as schema from '@/db/schema';
import { meetings } from '@/db/schema';

export interface FirstTranscriptLatency {
  event: 'first_transcript_latency';
  meetingId: string;
  source: string;
  /** Recording start → first transcript line stored. */
  latencyMs: number;
  /** Segment upload → first transcript line stored (streamed recordings). */
  sinceSegmentMs?: number;
  segmentIdx?: number;
}

/**
 * Stamp the first moment a meeting had transcript text and log the latency
 * as one structured line. Later calls for the same meeting are no-ops: the
 * loaded row short-circuits, and the conditional UPDATE settles races.
 */
export async function recordFirstTranscript(
  db: DrizzleD1Database<typeof schema>,
  meeting: { id: string; startedAt: number; source: string; firstTranscriptAt: number | null },
  segment?: { idx: number; createdAt: number },
  now = Date.now(),
): Promise<FirstTranscriptLatency | null> {
  if (meeting.firstTranscriptAt !== null) return null;
  const stamped = await db
    .update(meetings)
    .set({ firstTranscriptAt: now })
    .where(and(eq(meetings.id, meeting.id), isNull(meetings.firstTranscriptAt)))
    .returning({ id: meetings.id });
  if (stamped.length === 0) return null;
  const entry: FirstTranscriptLatency = {
    event: 'first_transcript_latency',
    meetingId: meeting.id,
    source: meeting.source,
    latencyMs: Math.max(0, now - meeting.startedAt),
    ...(segment
      ? { sinceSegmentMs: Math.max(0, now - segment.createdAt), segmentIdx: segment.idx }
      : {}),
  };
  console.log(JSON.stringify(entry));
  return entry;
}
