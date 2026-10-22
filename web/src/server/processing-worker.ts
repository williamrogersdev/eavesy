import * as schema from '@/db/schema';
import { drizzle } from 'drizzle-orm/d1';
import type { MessageBatch } from '@cloudflare/workers-types';
import { reportError } from '@/server/observability';
import {
  DEAD_LETTER_QUEUE,
  MAX_ATTEMPTS,
  type ProcessingEnv,
  type ProcessingMessage,
  SEGMENT_BUSY_RETRY_SECONDS,
  SegmentBusyError,
} from './processing/shared';
import { deadLetterQueue, handleTerminalFailure } from './processing/failure';
import { handleProcessRecording, handleTranscribeSegment } from './processing/transcribe';
import { handleSummarize } from './processing/summarize';
import { handleAgentTranscript } from './processing/agent-transcript';
import { handleEmbedDictation, handleEmbedMeeting } from './processing/embed';
import { handleCleanup, handlePurgeAccount } from './processing/cleanup';
import { collectBotRecording } from './meeting-bots/service';
import { checkCanary, startCanaries } from './meeting-bots/canary';
import { reconcileRecaps, sendRecap } from './email/recaps';

export async function queue(batch: MessageBatch<ProcessingMessage>, env: ProcessingEnv) {
  if (batch.queue === DEAD_LETTER_QUEUE) {
    await deadLetterQueue(batch, env);
    return;
  }
  for (const message of batch.messages) {
    try {
      await handle(message.body, env);
      message.ack();
    } catch (error) {
      if (error instanceof SegmentBusyError) {
        // Another job holds the claim. Check back after it should have finished;
        // by then the segment is complete or the claim is stale and reclaimable.
        if (message.attempts < MAX_ATTEMPTS) {
          message.retry({ delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
          continue;
        }
        // Out of retries, but the claim may belong to a worker that died and
        // won't go stale for a few more minutes. Start a fresh message rather
        // than drop the segment; the cron sweep is the backstop if this fails.
        try {
          await env.PROCESSING_QUEUE.send(message.body, { delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
          console.warn(
            JSON.stringify({ message: 'segment busy past retry budget; requeued', job: message.body }),
          );
          message.ack();
        } catch (sendError) {
          reportError('could not requeue busy segment', sendError, { job: message.body });
          message.retry({ delaySeconds: SEGMENT_BUSY_RETRY_SECONDS });
        }
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const terminal = message.attempts >= MAX_ATTEMPTS;
      if (terminal) {
        reportError('processing queue job failed permanently', error, {
          job: message.body,
          attempts: message.attempts,
        });
      } else {
        console.error(
          JSON.stringify({
            message: 'processing queue job failed',
            job: message.body,
            attempts: message.attempts,
            error: reason,
          }),
        );
      }
      if (!terminal) {
        message.retry({ delaySeconds: Math.min(300, 30 * message.attempts) });
        continue;
      }
      try {
        await handleTerminalFailure(message.body, env, reason);
        message.ack();
      } catch (recordError) {
        reportError('could not record terminal failure', recordError, { job: message.body });
        message.retry({ delaySeconds: 300 });
      }
    }
  }
}

async function handle(message: ProcessingMessage, env: ProcessingEnv) {
  const db = drizzle(env.DB, { schema });
  if ('meetingId' in message && ['process-recording', 'transcribe-segment', 'summarize', 'rolling-summarize', 'embed', 'agent-transcript'].includes(message.kind)) {
    const job = await env.DB.prepare('SELECT state FROM recording_imports WHERE meeting_id = ?').bind(message.meetingId).first<{ state: string }>();
    if (job && ['uploading', 'cancelled'].includes(job.state)) {
      console.info(JSON.stringify({ message: 'import job skipped until finalize', kind: message.kind, meetingId: message.meetingId, state: job.state }));
      return;
    }
  }
  switch (message.kind) {
    case 'process-recording':
      await handleProcessRecording(message.meetingId, db, env);
      return;
    case 'transcribe-segment':
      await handleTranscribeSegment(message.meetingId, message.idx, message.track ?? 'mixed', db, env);
      return;
    case 'rolling-summarize':
      await handleSummarize(message.meetingId, db, env, {
        final: false,
        throughIdx: message.throughIdx,
        throughMs: message.throughMs,
      });
      return;
    case 'summarize':
      await handleSummarize(message.meetingId, db, env, {
        final: true,
        waitingSince: message.waitingSince ?? Date.now(),
      });
      return;
    case 'embed':
      await handleEmbedMeeting(message.meetingId, db, env);
      return;
    case 'agent-transcript':
      await handleAgentTranscript(message.meetingId, db, env, { onlyIfMissing: message.onlyIfMissing });
      return;
    case 'embed-dictation':
      await handleEmbedDictation(message.dictationId, db, env);
      return;
    case 'cleanup-anonymous':
    case 'purge-meeting':
      await handleCleanup(message.meetingId, db, env);
      return;
    case 'purge-account':
      await handlePurgeAccount(message.userId, db, env);
      return;
    case 'collect-bot-recording':
      await collectBotRecording(db, env, message.botId);
      return;
    case 'send-recap':
      await sendRecap(db, env, message.meetingId);
      return;
    case 'check-canary':
      await checkCanary(db, env, message.botId, message.check);
      return;
    default: {
      const unhandled: never = message;
      throw new Error(
        `unhandled queue message kind: ${(unhandled as { kind: string }).kind}`,
      );
    }
  }
}

/** Daily: sends the notetaker's canary bots to their test meetings, if configured. */
export async function startMeetingBotCanaries(env: ProcessingEnv, now = Date.now()) {
  await startCanaries(drizzle(env.DB, { schema }), env, now);
}

/** Hourly: re-queues email recaps whose queue message was lost. */
export async function reconcileEmailRecaps(env: ProcessingEnv, now = Date.now()) {
  await reconcileRecaps(drizzle(env.DB, { schema }), env, now);
}

export { DROP_TTL_MS, PURGE_AFTER_MS, purgeDeleted } from './processing/cleanup';
export { recoverStaleSegments, sealLegacyKeys } from './processing/recovery';
export {
  DEAD_LETTER_QUEUE,
  MAX_ATTEMPTS,
  SEGMENT_CLAIM_TTL_MS,
  SUMMARY_WAIT_LIMIT_MS,
  type ProcessingEnv,
  type ProcessingMessage,
} from './processing/shared';
export { deadLetterQueue, type TerminalProcessingFailure } from './processing/failure';
export {
  ROLLING_NOTES_EVERY_MS,
  claimRollingNotes,
  crossesRollingNotesBoundary,
} from './processing/transcribe';
export { summaryRetryDelaySeconds } from './processing/summarize';
