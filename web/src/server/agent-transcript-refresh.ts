import { waitUntil } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { reportError } from '@/server/observability';
import { enqueue } from '@/server/queue';

/** Long enough that a burst of line edits rebuilds the cleaned transcript once. */
const REFRESH_DELAY_SECONDS = 30;

/**
 * The words or names behind the cleaned transcript changed: queue a rebuild,
 * then drop the stale copy so nobody pastes it. Queueing first means a failure
 * leaves the old copy in place rather than none and no rebuild coming.
 */
export async function refreshAgentTranscript(meetingId: string, userId: string): Promise<void> {
  try {
    const db = getDb();
    const owned = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), eq(meetings.status, 'complete')))
      .limit(1);
    if (owned.length === 0) return;
    // A burst of edits queues one rebuild each; the first to run does the work.
    await enqueue({ kind: 'agent-transcript', meetingId, onlyIfMissing: true }, { delaySeconds: REFRESH_DELAY_SECONDS });
    await db.update(meetings).set({ agentTranscriptMd: null }).where(eq(meetings.id, meetingId));
  } catch (error) {
    reportError('could not refresh agent transcript', error, { meetingId });
  }
}

/** Runs the refresh after the response, so a saved edit never waits on it. */
export function refreshAgentTranscriptLater(meetingId: string, userId: string): void {
  waitUntil(refreshAgentTranscript(meetingId, userId));
}
