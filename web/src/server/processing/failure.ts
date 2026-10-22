import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { MessageBatch } from '@cloudflare/workers-types';
import * as schema from '@/db/schema';
import { meetings, meetingSegments } from '@/db/schema';
import { encode } from '@/db/codec';
import { failCollection } from '@/server/meeting-bots/service';
import { failRecap } from '@/server/email/recaps';
import { type ProcessingEnv, type ProcessingMessage } from './shared';

export interface TerminalProcessingFailure {
  kind: ProcessingMessage['kind'];
  outcome: 'recorded' | 'recording-failed';
}

type TerminalFailureReporter = (failure: TerminalProcessingFailure) => void;

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
        .where(eq(meetings.id, message.meetingId));
      return;
    case 'collect-bot-recording':
      await failCollection(db, message.botId, reason);
      return;
    case 'send-recap':
      await failRecap(db, message.meetingId, reason);
      return;
    case 'check-canary':
      console.error(JSON.stringify({ message: 'meeting bot canary failed', alert: 'meeting_bot_canary', reason: 'check_failed', botId: message.botId, error: reason.slice(0, 300) }));
      return;
    case 'rolling-summarize':
    case 'agent-transcript':
    case 'embed':
    case 'embed-dictation':
    case 'cleanup-anonymous':
    case 'purge-meeting':
    case 'purge-account':
      return;
    default: {
      const unhandled: never = message;
      throw new Error(`unhandled queue message kind: ${(unhandled as { kind: string }).kind}`);
    }
  }
}

export async function deadLetterQueue(
  batch: MessageBatch<ProcessingMessage>,
  env: ProcessingEnv,
  report: TerminalFailureReporter = () => undefined,
) {
  for (const message of batch.messages) {
    try {
      const failure = await recordTerminalFailure(message.body, env);
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

async function recordTerminalFailure(
  message: ProcessingMessage,
  env: ProcessingEnv,
): Promise<TerminalProcessingFailure> {
  const terminalMeetingKinds = new Set<ProcessingMessage['kind']>([
    'process-recording',
    'transcribe-segment',
    'rolling-summarize',
    'summarize',
  ]);

  if ('meetingId' in message && terminalMeetingKinds.has(message.kind)) {
    const update = await env.DB.prepare(
      `UPDATE meetings
          SET status = 'failed',
              status_error = ?,
              updated_at = ?
        WHERE id = ?
          AND status IN ('recording', 'queued', 'uploading', 'processing')`,
    )
      .bind(
        `Automatic ${message.kind} processing failed after retries. The uploaded recording has been preserved.`,
        Date.now(),
        message.meetingId,
      )
      .run();
    if ((update.meta.changes ?? 0) === 0) {
      return { kind: message.kind, outcome: 'recorded' };
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

  return { kind: message.kind, outcome: 'recorded' };
}
