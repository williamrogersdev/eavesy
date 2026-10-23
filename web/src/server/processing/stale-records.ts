import { chunked, D1_IN_LIST_SIZE } from './queue-batch';
import type { ProcessingEnv } from './shared';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An import with no new segment for this long was abandoned mid-upload. */
export const IMPORT_IDLE_MS = DAY_MS;
/** A cancelled import keeps its audio this long, so resuming it soon re-uploads nothing. */
export const CANCELLED_IMPORT_KEEP_MS = 7 * DAY_MS;
/** OAuth codes live 60 s; an expired one is kept a day for debugging, then dropped. */
export const OAUTH_CODE_KEEP_MS = DAY_MS;
/** A registered OAuth client that never got a token in this long never will. */
export const OAUTH_CLIENT_UNUSED_MS = 30 * DAY_MS;
/** Webhook ids are kept to drop redeliveries; providers stop retrying within days. */
export const WEBHOOK_EVENT_KEEP_MS = 30 * DAY_MS;

const PRUNE_BATCH = 5_000;

/**
 * Imports left mid-upload (the tab closed, the Mac slept) match no other
 * sweep: they have segments, so they aren't "never uploaded", and recovery
 * leaves uploading imports alone. One idle for a day is cancelled the way the
 * user would cancel it, so selecting the file again resumes it.
 */
export async function stopStalledImports(env: Pick<ProcessingEnv, 'DB'>, now: number) {
  const before = now - IMPORT_IDLE_MS;
  // The same test on read and on both writes: an upload that resumes in
  // between makes the writes no-ops for it.
  const idle = (m: string) => `${m}.source = 'import' AND ${m}.status = 'uploading' AND ${m}.deleted_at IS NULL AND ${m}.updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = ${m}.id AND s.created_at >= ?)`;
  const stalled = await env.DB.prepare(
    `SELECT m.id FROM meetings m JOIN recording_imports r ON r.meeting_id = m.id
      WHERE r.state = 'uploading' AND ${idle('m')}
      LIMIT 200`,
  )
    .bind(before, before)
    .all<{ id: string }>();
  let stopped = 0;
  for (const ids of chunked(stalled.results.map((m) => m.id), D1_IN_LIST_SIZE)) {
    const list = ids.map(() => '?').join(', ');
    // One batch, so the import is cancelled exactly when its meeting fails:
    // cancelled, as a user cancel leaves it, so selecting the file resumes it.
    // The import goes first, while its meeting still reads as uploading.
    const [, failed] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE recording_imports SET state = 'cancelled'
          WHERE state = 'uploading' AND meeting_id IN (${list})
            AND EXISTS (SELECT 1 FROM meetings m WHERE m.id = recording_imports.meeting_id AND ${idle('m')})`,
      ).bind(...ids, before, before),
      env.DB.prepare(
        `UPDATE meetings
            SET status = 'failed',
                status_error = 'The import stopped before it finished uploading. Select the file again to resume.',
                updated_at = ?
          WHERE ${idle('meetings')} AND id IN (${list})
            AND EXISTS (SELECT 1 FROM recording_imports r WHERE r.meeting_id = meetings.id AND r.state = 'cancelled')`,
      ).bind(now, before, before, ...ids),
    ]);
    stopped += failed.meta.changes ?? 0;
  }
  return stopped;
}

const R2_DELETE_MAX = 1000;

/**
 * A cancelled import's audio is kept a week, then deleted with its segment
 * rows. Resuming later still works: the import shows nothing uploaded, so the
 * file is sent again.
 *
 * Only the objects its rows name are deleted, after a fresh check that it is
 * still cancelled, and then the rows naming them, whatever the import's state
 * by then: a row never outlives its audio. An import resumed in between sees
 * those pieces missing and uploads them again. A failed object delete leaves
 * the rows, so the next run tries again.
 */
export async function freeCancelledImports(env: Pick<ProcessingEnv, 'DB' | 'AUDIO_BUCKET'>, now: number) {
  const cancelled = await env.DB.prepare(
    `SELECT m.id, m.audio_r2_key AS audioKey
       FROM meetings m
       JOIN recording_imports r ON r.meeting_id = m.id
      WHERE r.state = 'cancelled' AND m.status = 'failed' AND m.deleted_at IS NULL AND m.updated_at < ?
        AND (m.audio_r2_key IS NOT NULL OR EXISTS (SELECT 1 FROM meeting_segments s WHERE s.meeting_id = m.id))
      LIMIT 50`,
  )
    .bind(now - CANCELLED_IMPORT_KEEP_MS)
    .all<{ id: string; audioKey: string | null }>();
  let freed = 0;
  for (const meeting of cancelled.results) {
    const segments = await env.DB.prepare('SELECT r2_key AS key FROM meeting_segments WHERE meeting_id = ?')
      .bind(meeting.id)
      .all<{ key: string }>();
    const state = await env.DB.prepare('SELECT state FROM recording_imports WHERE meeting_id = ?')
      .bind(meeting.id)
      .first<{ state: string }>();
    if (state?.state !== 'cancelled') continue;
    const segmentKeys = segments.results.map((row) => row.key);
    const keys = [...segmentKeys, ...(meeting.audioKey ? [meeting.audioKey] : [])];
    for (let i = 0; i < keys.length; i += R2_DELETE_MAX) await env.AUDIO_BUCKET.delete(keys.slice(i, i + R2_DELETE_MAX));
    await env.DB.batch([
      ...chunked(segmentKeys, D1_IN_LIST_SIZE).map((chunk) =>
        env.DB.prepare(`DELETE FROM meeting_segments WHERE meeting_id = ? AND r2_key IN (${chunk.map(() => '?').join(', ')})`)
          .bind(meeting.id, ...chunk)),
      env.DB.prepare('UPDATE meetings SET audio_r2_key = NULL, audio_format = NULL, audio_bytes = NULL WHERE id = ? AND audio_r2_key IS ?')
        .bind(meeting.id, meeting.audioKey),
    ]);
    freed += 1;
  }
  return freed;
}

/**
 * Rows nothing reads once they are old: spent OAuth codes, OAuth clients
 * registered (dynamic registration is open) but never used, and webhook ids
 * past any redelivery. Bounded per run; the rest waits an hour.
 */
export async function pruneAuthRecords(env: Pick<ProcessingEnv, 'DB'>, now: number) {
  await env.DB.batch([
    env.DB.prepare(
      'DELETE FROM oauth_codes WHERE code_hash IN (SELECT code_hash FROM oauth_codes WHERE expires_at < ? LIMIT ?)',
    ).bind(now - OAUTH_CODE_KEEP_MS, PRUNE_BATCH),
    env.DB.prepare(
      `DELETE FROM oauth_clients WHERE id IN (
         SELECT c.id FROM oauth_clients c
          WHERE c.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM mcp_tokens t WHERE t.client_id = c.id)
            AND NOT EXISTS (SELECT 1 FROM oauth_codes o WHERE o.client_id = c.id)
          LIMIT ?)`,
    ).bind(now - OAUTH_CLIENT_UNUSED_MS, PRUNE_BATCH),
    env.DB.prepare(
      'DELETE FROM provider_webhook_events WHERE id IN (SELECT id FROM provider_webhook_events WHERE received_at < ? LIMIT ?)',
    ).bind(now - WEBHOOK_EVENT_KEEP_MS, PRUNE_BATCH),
  ]);
}
