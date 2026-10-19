import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { reportError } from '@/server/observability';
import { enqueue } from '@/server/queue';

/** Long enough that a burst of line edits rebuilds the cleaned transcript once. */
const REFRESH_DELAY_SECONDS = 30;

/**
 * The words or names behind the cleaned transcript changed: drop the stale
 * copy, so nobody pastes it, and rebuild it shortly.
 */
export async function refreshAgentTranscript(meetingId: string, userId: string) {
  const cleared = await getDb()
    .update(meetings)
    .set({ agentTranscriptMd: null })
    .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), eq(meetings.status, 'complete')))
    .returning({ id: meetings.id });
  if (cleared.length === 0) return;
  try {
    await enqueue({ kind: 'agent-transcript', meetingId }, { delaySeconds: REFRESH_DELAY_SECONDS });
  } catch (error) {
    reportError('could not queue agent transcript refresh', error, { meetingId });
  }
}
