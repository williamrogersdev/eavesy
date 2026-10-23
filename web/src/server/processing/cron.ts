import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { reportError } from '@/server/observability';
import { pruneRateLimits } from '@/server/rate-limit-store';
import { reconcileRecaps } from '@/server/email/recaps';
import { requeueStaleCollections, retireRecallBots } from '@/server/meeting-bots/service';
import { purgeDeleted } from './cleanup';
import { chunked, D1_IN_LIST_SIZE, sendAll, sendMessages } from './queue-batch';
import { recoverStaleSegments, sealLegacyKeys } from './recovery';
import { type ProcessingEnv, SUMMARY_WAIT_LIMIT_MS } from './shared';

export type CronStep = readonly [name: string, run: () => Promise<unknown>];

/**
 * Runs every step even when an earlier one fails, reporting each failure on
 * its own. Throws once at the end, naming the failed steps, so the run still
 * shows as failed.
 */
export async function runCronSteps(steps: readonly CronStep[]) {
  const failed: string[] = [];
  for (const [name, run] of steps) {
    try {
      await run();
    } catch (error) {
      failed.push(name);
      reportError(`cron step failed: ${name}`, error, { step: name });
    }
  }
  if (failed.length) throw new Error(`cron steps failed: ${failed.join(', ')}`);
}

/** The hourly sweeps, in order. Each step is independent of the others. */
export function hourlySweeps(env: ProcessingEnv, now: number): CronStep[] {
  return [
    ['queue expired anonymous meetings', () => queueExpiredMeetings(env, now)],
    ['delete expired pairing codes', () => env.DB.prepare('DELETE FROM device_pairing_codes WHERE expires_at < ?').bind(now).run()],
    ['finish abandoned recordings', () => finishAbandonedRecordings(env, now)],
    ['retry delayed browser recordings', () => retryDelayedRecordings(env, now)],
    ['fail recordings that never uploaded', () => failRecordingsWithoutAudio(env, now)],
    ['resume stuck summaries', () => resumeStuckSummaries(env, now)],
    ['recover stale segments', () => recoverStaleSegments(env, now)],
    ['requeue stale bot collections', () => requeueStaleCollections(env, now)],
    ['retire Recall.ai bots', () => retireRecallBots(env)],
    ['reconcile email recaps', () => reconcileRecaps(drizzle(env.DB, { schema }), env, now)],
    ['purge deleted data', () => purgeDeleted(env, now)],
    ['prune rate limits', () => pruneRateLimits(env.DB, now)],
    ['seal legacy keys', () => sealLegacyKeys(env)],
  ];
}

async function queueExpiredMeetings(env: ProcessingEnv, now: number) {
  const expired = await env.DB.prepare(
    'SELECT id FROM meetings WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 500',
  )
    .bind(now)
    .all<{ id: string }>();
  await sendMessages(
    env.PROCESSING_QUEUE,
    expired.results.map((m) => ({ kind: 'cleanup-anonymous', meetingId: m.id })),
    'expired meeting cleanup',
  );
}

/**
 * Recordings whose app stopped talking to us half an hour ago are finished
 * with what arrived. Notetaker meetings aren't touched between segments; their
 * bot's watchdog ends them instead (meeting-bots/service.ts, watchBot).
 */
async function finishAbandonedRecordings(env: ProcessingEnv, now: number) {
  const abandoned = await env.DB.prepare(
    `SELECT m.id
       FROM meetings m
      WHERE m.source NOT IN ('import', 'bot') AND m.status IN ('recording', 'uploading')
        AND m.updated_at < ?
        AND EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id)
      LIMIT 200`,
  )
    .bind(now - 30 * 60 * 1000)
    .all<{ id: string }>();
  const moved: string[] = [];
  for (const ids of chunked(abandoned.results.map((m) => m.id), D1_IN_LIST_SIZE)) {
    const updated = await env.DB.prepare(
      `UPDATE meetings
          SET status = 'processing', ended_at = COALESCE(ended_at, ?), updated_at = ?
        WHERE id IN (${ids.map(() => '?').join(', ')}) AND status IN ('recording', 'uploading')
        RETURNING id`,
    )
      .bind(now, now, ...ids)
      .all<{ id: string }>();
    moved.push(...updated.results.map((m) => m.id));
  }
  await sendMessages(
    env.PROCESSING_QUEUE,
    moved.map((meetingId) => ({ kind: 'summarize', meetingId })),
    'abandoned recording summary',
  );
}

async function retryDelayedRecordings(env: ProcessingEnv, now: number) {
  const delayed = await env.DB.prepare(
    `SELECT m.id
       FROM meetings m
      WHERE m.source IN ('web', 'import')
        AND m.status = 'processing'
        AND m.audio_r2_key IS NOT NULL
        AND m.updated_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM transcript_segments t WHERE t.meeting_id = m.id
        )
        -- Streamed sessions are transcribed per segment, never as one file.
        AND NOT EXISTS (
          SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id
        )
      LIMIT 200`,
  )
    .bind(now - 5 * 60 * 1000)
    .all<{ id: string }>();
  await sendMessages(
    env.PROCESSING_QUEUE,
    delayed.results.map((m) => ({ kind: 'process-recording', meetingId: m.id })),
    'delayed browser recording',
  );
}

async function failRecordingsWithoutAudio(env: ProcessingEnv, now: number) {
  await env.DB.prepare(
    `UPDATE meetings
        SET status = 'failed',
            status_error = 'The recording stopped before any audio reached the cloud.',
            updated_at = ?
      WHERE status IN ('recording', 'uploading')
        AND source != 'bot'
        AND updated_at < ?
        AND audio_r2_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = meetings.id)`,
  )
    .bind(now, now - SUMMARY_WAIT_LIMIT_MS)
    .run();
}

async function resumeStuckSummaries(env: ProcessingEnv, now: number) {
  const stuck = await env.DB.prepare(
    `SELECT id, updated_at FROM meetings WHERE status = 'processing' AND updated_at < ? LIMIT 200`,
  )
    .bind(now - 2 * SUMMARY_WAIT_LIMIT_MS)
    .all<{ id: string; updated_at: number }>();
  for (const chunk of chunked(stuck.results, D1_IN_LIST_SIZE)) {
    await env.DB.prepare(`UPDATE meetings SET updated_at = ? WHERE id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(now, ...chunk.map((m) => m.id))
      .run();
  }
  await sendAll(
    env.PROCESSING_QUEUE,
    stuck.results.map((m) => ({
      item: m.id,
      body: { kind: 'summarize', meetingId: m.id, waitingSince: m.updated_at },
    })),
    'stuck meeting summary',
  );
}
