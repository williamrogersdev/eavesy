import type {
  D1Database,
  MessageBatch,
  Queue,
  R2Bucket,
  ScheduledController,
  VectorizeIndex,
  Ai,
} from '@cloudflare/workers-types';
import { captureMessage, withErrorReporting } from '../../../web/src/server/observability';

import {
  deadLetterQueue,
  purgeDeleted,
  reconcileEmailRecaps,
  recoverStaleSegments,
  sealLegacyKeys,
  SUMMARY_WAIT_LIMIT_MS,
  queue as runQueue,
  type ProcessingEnv,
  type ProcessingMessage,
} from '../../../web/src/server/processing-worker';
import { pruneRateLimits } from '../../../web/src/server/rate-limit-store';

export interface Env extends ProcessingEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  VECTORIZE: VectorizeIndex;
  PROCESSING_QUEUE: Queue<ProcessingMessage>;
  AI: Ai;
  ANTHROPIC_API_KEY: string;
  RESEND_API_KEY?: string;
  RESEND_WEBHOOK_SECRET?: string;
  EMAIL_FROM?: string;
  APP_URL?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  RELEASE?: string;
}

export const worker = {
  async fetch(): Promise<Response> {
    return new Response('eavesy-processing: queue + cron', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  },

  async queue(batch: MessageBatch<ProcessingMessage>, env: Env): Promise<void> {
    if (batch.queue === 'eavesy-processing-dlq') {
      await deadLetterQueue(batch, env, (failure) => {
        captureMessage('Processing job exhausted automatic retries', {
          tags: {
            job_kind: failure.kind,
            failure_outcome: failure.outcome,
          },
        });
      });
      return;
    }
    await runQueue(batch, env);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const now = Date.now();
    const expired = await env.DB.prepare(
      'SELECT id FROM meetings WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT 500',
    )
      .bind(now)
      .all<{ id: string }>();

    for (const m of expired.results) {
      await env.PROCESSING_QUEUE.send({ kind: 'cleanup-anonymous', meetingId: m.id });
    }
    await env.DB.prepare('DELETE FROM device_pairing_codes WHERE expires_at < ?').bind(now).run();

    const abandoned = await env.DB.prepare(
      `SELECT m.id
         FROM meetings m
        WHERE m.source != 'import' AND m.status IN ('recording', 'uploading')
          AND m.updated_at < ?
          AND EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id)
        LIMIT 200`,
    )
      .bind(now - 30 * 60 * 1000)
      .all<{ id: string }>();
    for (const meeting of abandoned.results) {
      await env.DB.prepare(
        `UPDATE meetings
            SET status = 'processing', ended_at = COALESCE(ended_at, ?), updated_at = ?
          WHERE id = ? AND status IN ('recording', 'uploading')`,
      )
        .bind(now, now, meeting.id)
        .run();
      await env.PROCESSING_QUEUE.send({ kind: 'summarize', meetingId: meeting.id });
    }

    const delayedBrowserJobs = await env.DB.prepare(
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
    for (const meeting of delayedBrowserJobs.results) {
      await env.PROCESSING_QUEUE.send({ kind: 'process-recording', meetingId: meeting.id });
    }

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

    const stuck = await env.DB.prepare(
      `SELECT id, updated_at FROM meetings WHERE status = 'processing' AND updated_at < ? LIMIT 200`,
    ).bind(now - 2 * SUMMARY_WAIT_LIMIT_MS).all<{ id: string; updated_at: number }>();
    for (const meeting of stuck.results) {
      await env.DB.prepare('UPDATE meetings SET updated_at = ? WHERE id = ?').bind(now, meeting.id).run();
      await env.PROCESSING_QUEUE.send({ kind: 'summarize', meetingId: meeting.id, waitingSince: meeting.updated_at });
    }
    await recoverStaleSegments(env, now);
    await reconcileEmailRecaps(env, now);
    await purgeDeleted(env, now);
    await pruneRateLimits(env.DB, now);
    await sealLegacyKeys(env);
    await rollupOperationalMetrics(env, now);
  },
};

export async function rollupOperationalMetrics(env: Env, now = Date.now()): Promise<void> {
  await rollupDay(env.DB, now - 24 * 60 * 60 * 1_000, now);
  await rollupDay(env.DB, now, now);
}

async function rollupDay(db: D1Database, dayAt: number, observedAt: number): Promise<void> {
  const day = new Date(dayAt);
  const date = day.toISOString().slice(0, 10);
  const start = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const end = start + 24 * 60 * 60 * 1_000;
  const isCurrentDay = date === new Date(observedAt).toISOString().slice(0, 10);

  const [
    funnel,
    meetingStarts,
    outcomes,
    firstRecordings,
    firstTranscripts,
    firstBriefUses,
    briefUses,
    firstReturns7d,
    transcriptChars,
    summaryChars,
    stuckMeetings,
    firstTranscriptLatency,
  ] =
    await Promise.all([
      db.prepare(
        `SELECT
           (SELECT count(*) FROM users
             WHERE is_anonymous = 0 AND created_at >= ? AND created_at < ?) AS signups,
           (SELECT count(*) FROM users
             WHERE onboarding_completed_at >= ? AND onboarding_completed_at < ?) AS onboarded_users,
           (SELECT count(*) FROM devices
             WHERE created_at >= ? AND created_at < ?) AS paired_devices`,
      )
        .bind(start, end, start, end, start, end)
        .first<{ signups: number; onboarded_users: number; paired_devices: number }>(),
      db.prepare(
        `SELECT
           count(*) AS meetings_started,
           coalesce(sum(coalesce(audio_duration_sec, duration_sec, 0)), 0) AS audio_seconds
         FROM meetings
        WHERE created_at >= ? AND created_at < ?`,
      )
        .bind(start, end)
        .first<{
          meetings_started: number;
          audio_seconds: number | null;
        }>(),
      db.prepare(
        `WITH terminal AS (
           SELECT meeting_id,
                  min(CASE WHEN event_type = 'meeting.complete' THEN created_at END) AS complete_at,
                  max(CASE WHEN event_type = 'meeting.fail' THEN 1 ELSE 0 END) AS failed
             FROM activity_log
            WHERE created_at >= ? AND created_at < ?
              AND event_type IN ('meeting.complete', 'meeting.fail')
            GROUP BY meeting_id
         )
         SELECT count(complete_at) AS meetings_completed,
                coalesce(sum(failed), 0) AS meetings_failed,
                count(CASE WHEN complete_at IS NOT NULL AND m.ended_at IS NOT NULL THEN 1 END)
                  AS processing_samples,
                coalesce(sum(CASE
                  WHEN complete_at IS NULL OR m.ended_at IS NULL THEN 0
                  WHEN complete_at >= m.ended_at THEN complete_at - m.ended_at
                  ELSE 0 END), 0) AS processing_ms_total,
                coalesce(max(CASE
                  WHEN complete_at IS NULL OR m.ended_at IS NULL THEN 0
                  WHEN complete_at >= m.ended_at THEN complete_at - m.ended_at
                  ELSE 0 END), 0) AS processing_ms_max
           FROM terminal
           LEFT JOIN meetings m ON m.id = terminal.meeting_id`,
      )
        .bind(start, end)
        .first<{
          meetings_completed: number;
          meetings_failed: number;
          processing_samples: number;
          processing_ms_total: number;
          processing_ms_max: number;
        }>(),
      // The "first …" metrics start from the day's rows and look back per user
      // through an index, instead of grouping every user's whole history.
      db.prepare(
        `SELECT count(DISTINCT m.user_id) AS count
           FROM meetings m
          WHERE m.created_at >= ? AND m.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM meetings earlier
               WHERE earlier.user_id = m.user_id AND earlier.created_at < ?
            )`,
      )
        .bind(start, end, start)
        .first<{ count: number }>(),
      db.prepare(
        `SELECT count(DISTINCT a.user_id) AS count
           FROM activity_log a
          WHERE a.event_type = 'meeting.complete'
            AND a.created_at >= ? AND a.created_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM activity_log earlier
               WHERE earlier.user_id = a.user_id
                 AND earlier.event_type = 'meeting.complete'
                 AND earlier.created_at < ?
            )`,
      )
        .bind(start, end, start)
        .first<{ count: number }>(),
      db.prepare(
        `SELECT count(DISTINCT used.user_id) AS count
           FROM activity_log used
          WHERE used.event_type IN ('meeting.copy', 'meeting.export')
            AND used.created_at >= ? AND used.created_at < ?
            AND EXISTS (
              SELECT 1 FROM activity_log completed
               WHERE completed.meeting_id = used.meeting_id
                 AND completed.event_type = 'meeting.complete'
                 AND completed.created_at <= used.created_at
            )
            AND NOT EXISTS (
              SELECT 1 FROM activity_log earlier
               WHERE earlier.user_id = used.user_id
                 AND earlier.event_type IN ('meeting.copy', 'meeting.export')
                 AND earlier.created_at < ?
                 AND EXISTS (
                   SELECT 1 FROM activity_log completed
                    WHERE completed.meeting_id = earlier.meeting_id
                      AND completed.event_type = 'meeting.complete'
                      AND completed.created_at <= earlier.created_at
                 )
            )`,
      )
        .bind(start, end, start)
        .first<{ count: number }>(),
      db.prepare(
        `SELECT count(DISTINCT used.meeting_id) AS count
           FROM activity_log used
          WHERE used.event_type IN ('meeting.copy', 'meeting.export')
            AND used.created_at >= ? AND used.created_at < ?
            AND EXISTS (
              SELECT 1 FROM activity_log completed
               WHERE completed.meeting_id = used.meeting_id
                 AND completed.event_type = 'meeting.complete'
                 AND completed.created_at <= used.created_at
            )`,
      )
        .bind(start, end)
        .first<{ count: number }>(),
      // A return that happened today is a meeting started today, so only users
      // with a meeting started today can count.
      db.prepare(
        `WITH candidates AS (
           SELECT DISTINCT m.user_id,
                  (SELECT min(f.started_at) FROM meetings f WHERE f.user_id = m.user_id) AS first_at
             FROM meetings m
            WHERE m.started_at >= ? AND m.started_at < ?
         ), returns AS (
           SELECT (SELECT min(r.started_at) FROM meetings r
                    WHERE r.user_id = candidates.user_id
                      AND r.started_at > candidates.first_at
                      AND r.started_at <= candidates.first_at + 7 * 24 * 60 * 60 * 1000) AS returned_at
             FROM candidates
         )
         SELECT count(*) AS count
           FROM returns
          WHERE returned_at >= ? AND returned_at < ?`,
      )
        .bind(start, end, start, end)
        .first<{ count: number }>(),
      db.prepare(
        `SELECT coalesce(sum(length(t.text)), 0) AS chars
           FROM transcript_segments t
           JOIN meetings m ON m.id = t.meeting_id
           JOIN summaries s ON s.meeting_id = m.id
          WHERE m.created_at >= ? AND m.created_at < ?
            AND s.generated_by_model NOT LIKE 'openrouter:%'
            AND s.generated_by_model NOT LIKE 'byo-anthropic:%'`,
      )
        .bind(start, end)
        .first<{ chars: number }>(),
      db.prepare(
        `SELECT coalesce(sum(
           length(s.tldr) + length(s.decisions_json) + length(s.action_items_json) +
           length(s.follow_ups_json) + length(s.open_questions_json) +
           length(s.topics_json) + length(s.mentions_json)
         ), 0) AS chars
           FROM summaries s
           JOIN meetings m ON m.id = s.meeting_id
          WHERE m.created_at >= ? AND m.created_at < ?
            AND s.generated_by_model NOT LIKE 'openrouter:%'
            AND s.generated_by_model NOT LIKE 'byo-anthropic:%'`,
      )
        .bind(start, end)
        .first<{ chars: number }>(),
      isCurrentDay
        ? db.prepare(
            `SELECT count(*) AS count
               FROM meetings
              WHERE status = 'processing' AND updated_at < ?`,
          )
            .bind(observedAt - 30 * 60 * 1_000)
            .first<{ count: number }>()
        : db.prepare(
            `SELECT meetings_stuck AS count
               FROM product_metrics_daily
              WHERE date = ?`,
          )
            .bind(date)
            .first<{ count: number }>(),
      // Streamed recordings only: an uploaded file's first line arrives after
      // the whole recording, which would swamp the live-transcript signal.
      db.prepare(
        `SELECT count(*) AS samples,
                coalesce(sum(first_transcript_at - started_at), 0) AS ms_total,
                coalesce(max(first_transcript_at - started_at), 0) AS ms_max
           FROM meetings m
          WHERE m.first_transcript_at >= ? AND m.first_transcript_at < ?
            AND m.first_transcript_at >= m.started_at
            AND EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id)`,
      )
        .bind(start, end)
        .first<{ samples: number; ms_total: number; ms_max: number }>(),
    ]);

  const audioSeconds = meetingStarts?.audio_seconds ?? 0;
  const estimatedAiCostMicrousd = Math.round(
    (audioSeconds / 60) * 510 +
      ((transcriptChars?.chars ?? 0) / 4) * 3 +
      ((summaryChars?.chars ?? 0) / 4) * 15,
  );

  await db.prepare(
    `INSERT INTO product_metrics_daily
      (date, signups, onboarded_users, paired_devices, users_first_recording,
       users_first_transcript, users_first_brief_use, users_first_return_7d,
       meetings_started, meetings_completed, meetings_brief_used,
       meetings_failed, meetings_stuck, processing_samples,
       processing_ms_total, processing_ms_max, first_transcript_samples,
       first_transcript_ms_total, first_transcript_ms_max, audio_seconds,
       estimated_ai_cost_microusd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       signups = excluded.signups,
       onboarded_users = excluded.onboarded_users,
       paired_devices = excluded.paired_devices,
       users_first_recording = excluded.users_first_recording,
       users_first_transcript = excluded.users_first_transcript,
       users_first_brief_use = excluded.users_first_brief_use,
       users_first_return_7d = excluded.users_first_return_7d,
       meetings_started = excluded.meetings_started,
       meetings_completed = excluded.meetings_completed,
       meetings_brief_used = excluded.meetings_brief_used,
       meetings_failed = excluded.meetings_failed,
       meetings_stuck = excluded.meetings_stuck,
       processing_samples = excluded.processing_samples,
       processing_ms_total = excluded.processing_ms_total,
       processing_ms_max = excluded.processing_ms_max,
       first_transcript_samples = excluded.first_transcript_samples,
       first_transcript_ms_total = excluded.first_transcript_ms_total,
       first_transcript_ms_max = excluded.first_transcript_ms_max,
       audio_seconds = excluded.audio_seconds,
       estimated_ai_cost_microusd = excluded.estimated_ai_cost_microusd,
       updated_at = excluded.updated_at`,
  )
    .bind(
      date,
      funnel?.signups ?? 0,
      funnel?.onboarded_users ?? 0,
      funnel?.paired_devices ?? 0,
      firstRecordings?.count ?? 0,
      firstTranscripts?.count ?? 0,
      firstBriefUses?.count ?? 0,
      firstReturns7d?.count ?? 0,
      meetingStarts?.meetings_started ?? 0,
      outcomes?.meetings_completed ?? 0,
      briefUses?.count ?? 0,
      outcomes?.meetings_failed ?? 0,
      stuckMeetings?.count ?? 0,
      outcomes?.processing_samples ?? 0,
      outcomes?.processing_ms_total ?? 0,
      outcomes?.processing_ms_max ?? 0,
      firstTranscriptLatency?.samples ?? 0,
      firstTranscriptLatency?.ms_total ?? 0,
      firstTranscriptLatency?.ms_max ?? 0,
      audioSeconds,
      estimatedAiCostMicrousd,
      observedAt,
    )
    .run();
}

export default withErrorReporting<Env, ProcessingMessage>({ service: 'processing' }, { ...worker });
