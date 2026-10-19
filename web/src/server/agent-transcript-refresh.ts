import { waitUntil } from 'cloudflare:workers';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetings } from '@/db/schema';
import { reportError } from '@/server/observability';
import { enqueue } from '@/server/queue';

/** Long enough that a burst of line edits rebuilds the cleaned transcript once. */
const REFRESH_DELAY_SECONDS = 30;

/**
 * The words or names behind the cleaned transcript changed. One statement
 * drops the stale copy and bumps the revision, so readers fall back to the
 * raw transcript and any rebuild already running can't save over the edit;
 * then a rebuild for the new revision is queued.
 */
export async function refreshAgentTranscript(meetingId: string, userId: string): Promise<void> {
  let rev: number | undefined;
  try {
    const bumped = await getDb()
      .update(meetings)
      .set({ agentTranscriptMd: null, agentTranscriptRev: sql`${meetings.agentTranscriptRev} + 1` })
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId), eq(meetings.status, 'complete')))
      .returning({ rev: meetings.agentTranscriptRev });
    rev = bumped[0]?.rev;
    if (rev === undefined) return;
    await enqueueRebuild(meetingId, rev);
  } catch (error) {
    // The edit is saved and nobody is shown a stale copy; only the rebuild is lost.
    reportError('could not refresh agent transcript', error, { meetingId, rev });
  }
}

async function enqueueRebuild(meetingId: string, rev: number) {
  const message = { kind: 'agent-transcript' as const, meetingId, rev };
  try {
    await enqueue(message, { delaySeconds: REFRESH_DELAY_SECONDS });
  } catch {
    await enqueue(message, { delaySeconds: REFRESH_DELAY_SECONDS });
  }
}

/** Runs the refresh after the response, so a saved edit never waits on it. */
export function refreshAgentTranscriptLater(meetingId: string, userId: string): void {
  const refresh = refreshAgentTranscript(meetingId, userId);
  try {
    waitUntil(refresh);
  } catch {
    // Outside a request (scripts, tests) there is nothing to extend; the promise still runs.
    void refresh;
  }
}
