import { and, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { MessageBatch } from '@cloudflare/workers-types';
import * as schema from '@/db/schema';
import { meetings, meetingSegments } from '@/db/schema';
import { encode } from '@/db/codec';
import { captureMessage } from '@/server/observability';
import { failCollection } from '@/server/meeting-bots/service';
import { failCanaryCheck } from '@/server/meeting-bots/canary';
import { failRecap } from '@/server/email/recaps';
import { type ProcessingEnv, type ProcessingMessage, SUMMARY_CLAIM_TTL_MS } from './shared';

export interface TerminalProcessingFailure {
  kind: ProcessingMessage['kind'];
  /** `left-to-live-job`: another job still holds the meeting's summary claim, so nothing was failed. */
  outcome: 'recorded' | 'recording-failed' | 'left-to-live-job';
}

type TerminalFailureReporter = (failure: TerminalProcessingFailure) => void;

/** A meeting in one of these can still be failed; a finished one is left alone. */
const IN_PROGRESS = ['recording', 'queued', 'uploading', 'processing'] as const;

/** Records a job that is out of retries, so nothing waits on it forever. */
export async function handleTerminalFailure(message: ProcessingMessage, env: ProcessingEnv, reason: string) {
  const db = drizzle(env.DB, { schema });
  switch (message.kind) {
    case 'transcribe-segment':
      await db
        .update(meetingSegments)
        .set({ transcribeStatus: 'failed' })
        .where(
          and(
            eq(meetingSegments.meetingId, message.meetingId),
            eq(meetingSegments.idx, message.idx),
            eq(meetingSegments.track, message.track ?? 'mixed'),
            // A duplicate's failure must not undo another job's transcript.
            ne(meetingSegments.transcribeStatus, 'complete'),
          ),
        );
      return;
    case 'process-recording':
      await recordTerminalFailure(message, env);
      return;
    case 'summarize':
      await db
        .update(meetings)
        .set({ status: 'failed', statusError: `Summary failed: ${reason.slice(0, 500)}`, updatedAt: Date.now() })
        .where(and(eq(meetings.id, message.meetingId), inArray(meetings.status, [...IN_PROGRESS])));
      return;
    case 'collect-bot-recording':
      await failCollection(db, message.botId, reason);
      return;
    case 'send-recap':
      await failRecap(db, message.meetingId, reason);
      return;
    case 'check-canary':
      await failCanaryCheck(db, env, message.botId, message.platform, reason);
      return;
    case 'purge-account':
      // Nothing retries this on its own, and the account's data is still
      // there: someone has to look.
      captureMessage('Account purge failed permanently; the account and its data remain', {
        tags: { job_kind: message.kind, user_id: message.userId, reason: reason.slice(0, 200) },
      });
      return;
    // A meeting that never gets embedded is usable but invisible to semantic
    // search and the library, and nothing re-queues it on its own: say so.
    case 'embed':
      captureMessage('Meeting embedding failed permanently; it is missing from semantic search', {
        tags: { job_kind: message.kind, meeting_id: message.meetingId, reason: reason.slice(0, 200) },
      });
      return;
    case 'embed-dictation':
      captureMessage('Dictation embedding failed permanently; it is missing from semantic search', {
        tags: { job_kind: message.kind, dictation_id: message.dictationId, reason: reason.slice(0, 200) },
      });
      return;
    // The hourly cron re-sends deleted-meeting and expiry purges; the rest are
    // best effort on a meeting that is already usable.
    case 'rolling-summarize':
    case 'agent-transcript':
    case 'cleanup-anonymous':
    case 'purge-meeting':
      return;
    default: {
      const unhandled: never = message;
      throw new Error(`unhandled queue message kind: ${(unhandled as { kind: string }).kind}`);
    }
  }
}

function reportDeadLetter(failure: TerminalProcessingFailure) {
  captureMessage('Processing job exhausted automatic retries', {
    tags: { job_kind: failure.kind, failure_outcome: failure.outcome },
  });
}

/**
 * The dead-letter queue gets a message whose last delivery crashed the
 * consumer, or could not record its own failure. It records the failure the
 * way the consumer would have.
 */
export async function deadLetterQueue(
  batch: MessageBatch<ProcessingMessage>,
  env: ProcessingEnv,
  report: TerminalFailureReporter = reportDeadLetter,
) {
  for (const message of batch.messages) {
    try {
      const failure = await recordDeadLetter(message.body, env);
      console.error(
        JSON.stringify({
          message: 'processing job exhausted retries',
          jobKind: failure.kind,
          outcome: failure.outcome,
          queueMessageId: message.id,
        }),
      );
      report(failure);
      message.ack();
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'could not persist terminal processing failure',
          jobKind: message.body.kind,
          queueMessageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      message.retry({ delaySeconds: 60 });
    }
  }
}

async function recordDeadLetter(message: ProcessingMessage, env: ProcessingEnv): Promise<TerminalProcessingFailure> {
  // Only these two jobs carry the whole meeting. One lost segment or a
  // rolling note leaves a gap, not a failed meeting.
  if (message.kind === 'process-recording' || message.kind === 'summarize') {
    return recordTerminalFailure(message, env);
  }
  await handleTerminalFailure(message, env, 'consumer crashed');
  return { kind: message.kind, outcome: 'recorded' };
}

async function recordTerminalFailure(
  message: Extract<ProcessingMessage, { kind: 'process-recording' | 'summarize' }>,
  env: ProcessingEnv,
): Promise<TerminalProcessingFailure> {
  // A meeting whose summary a live job still holds is not lost: that job
  // finishes it, or the stuck-summary sweep takes over once the claim goes
  // stale. (A busy summarize job that could not requeue itself ends up here
  // while the other job is still running.) Failing it underneath would show
  // a failure the other job then reverts.
  const now = Date.now();
  const update = await env.DB.prepare(
    `UPDATE meetings
        SET status = 'failed',
            status_error = ?,
            updated_at = ?
      WHERE id = ?
        AND status IN ('recording', 'queued', 'uploading', 'processing')
        AND (summary_claimed_at IS NULL OR summary_claimed_at < ?)`,
  )
    .bind(
      `Automatic ${message.kind} processing failed after retries. The uploaded recording has been preserved.`,
      now,
      message.meetingId,
      now - SUMMARY_CLAIM_TTL_MS,
    )
    .run();
  if ((update.meta.changes ?? 0) === 0) {
    const claim = await env.DB.prepare(
      `SELECT summary_claimed_at AS claimedAt FROM meetings
        WHERE id = ? AND status IN ('recording', 'queued', 'uploading', 'processing')`,
    )
      .bind(message.meetingId)
      .first<{ claimedAt: number | null }>();
    const live = claim?.claimedAt != null && claim.claimedAt >= now - SUMMARY_CLAIM_TTL_MS;
    return { kind: message.kind, outcome: live ? 'left-to-live-job' : 'recorded' };
  }
  await env.DB.prepare(
    `INSERT OR IGNORE INTO activity_log
      (id, user_id, event_type, meeting_id, metadata_json, created_at)
     SELECT ?, user_id, 'meeting.fail', id, ?, ?
       FROM meetings
      WHERE id = ?`,
  )
    .bind(
      `act_dlq_${message.kind}_${message.meetingId}`,
      encode({ reason: 'automatic_retries_exhausted', jobKind: message.kind }),
      Date.now(),
      message.meetingId,
    )
    .run();
  return { kind: message.kind, outcome: 'recording-failed' };
}
