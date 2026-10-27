import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { meetings, meetingSegments, users } from '@/db/schema';
import { reportError } from '@/server/observability';
import { isSealed, sealSecret } from '@/server/secret-box';
import { chunked, D1_IN_LIST_SIZE, sendAll } from './queue-batch';
import { type ProcessingEnv, SEGMENT_CLAIM_TTL_MS } from './shared';

const STALE_SEGMENT_SWEEP_LIMIT = 100;
/**
 * A segment still `pending` this long after it was stored lost its queue
 * message (a failed send after the row was written). Normal queue latency is
 * seconds, so this only catches the lost ones.
 */
export const PENDING_SEGMENT_GRACE_MS = 15 * 60 * 1_000;

/**
 * Queue segments whose transcription job is gone: a claim that outlived any
 * possible consumer (the worker died after its message gave up), or a row
 * that never got a message at all. Without this either one leaves a gap in
 * the transcript, and the final summary waits on it for hours.
 *
 * Only meetings still in progress are swept. A deleted or failed meeting's
 * audio never needs transcribing again, and a completed one already has its
 * summary, recap and embeddings built on the transcript it has: a segment the
 * final summary gave up waiting for must not change that transcript later.
 * Imports still uploading or cancelled are skipped too; finalize queues their
 * segments, or never.
 *
 * Rows are sent first and a stale claim is reset to 'pending' only after its
 * send succeeds, so a failed send leaves the row for the next sweep. Failures
 * are reported, never thrown: the rest of the cron must still run.
 */
export async function recoverStaleSegments(env: ProcessingEnv, now = Date.now()) {
  const db = drizzle(env.DB, { schema });
  const staleClaim = and(
    eq(meetingSegments.transcribeStatus, 'processing'),
    or(isNull(meetingSegments.transcribeClaimedAt), lt(meetingSegments.transcribeClaimedAt, now - SEGMENT_CLAIM_TTL_MS)),
  );
  const neverQueued = and(
    eq(meetingSegments.transcribeStatus, 'pending'),
    lt(meetingSegments.createdAt, now - PENDING_SEGMENT_GRACE_MS),
  );
  const stillWanted = and(
    isNull(meetings.deletedAt),
    inArray(meetings.status, ['recording', 'queued', 'uploading', 'processing']),
    sql`NOT EXISTS (
      SELECT 1 FROM recording_imports i
       WHERE i.meeting_id = ${meetingSegments.meetingId} AND i.state IN ('uploading', 'cancelled', 'freeing')
    )`,
  );
  const lookup = (which: typeof staleClaim) =>
    db
      .select({
        id: meetingSegments.id,
        status: meetingSegments.transcribeStatus,
        meetingId: meetingSegments.meetingId,
        idx: meetingSegments.idx,
        track: meetingSegments.track,
      })
      .from(meetingSegments)
      .innerJoin(meetings, eq(meetings.id, meetingSegments.meetingId))
      .where(and(which, stillWanted))
      .limit(STALE_SEGMENT_SWEEP_LIMIT);
  let candidates;
  try {
    candidates = [...(await lookup(staleClaim)), ...(await lookup(neverQueued))];
  } catch (error) {
    reportError('could not look up stale segments', error);
    return;
  }
  if (candidates.length === 0) return;

  const sent = await sendAll(
    env.PROCESSING_QUEUE,
    candidates.map((segment) => ({
      item: segment,
      body: { kind: 'transcribe-segment', meetingId: segment.meetingId, idx: segment.idx, track: segment.track },
    })),
    'stale segment',
  );
  // Conditional on still being stale: if the message was already picked up
  // and claimed, the fresh claim is left alone.
  const claimed = sent.filter((segment) => segment.status === 'processing').map((segment) => segment.id);
  try {
    for (const ids of chunked(claimed, D1_IN_LIST_SIZE)) {
      await db
        .update(meetingSegments)
        .set({ transcribeStatus: 'pending', transcribeClaimedAt: null })
        .where(and(inArray(meetingSegments.id, ids), staleClaim));
    }
  } catch (error) {
    reportError('could not reset stale segment claims', error, { count: claimed.length });
  }
  console.warn(
    JSON.stringify({ message: 'requeued stale segments', count: sent.length, failed: candidates.length - sent.length }),
  );
}

export async function sealLegacyKeys(env: ProcessingEnv) {
  const db = drizzle(env.DB, { schema });
  const rows = await db
    .select({
      id: users.id,
      byoAnthropicKey: users.byoAnthropicKey,
      byoDeepgramKey: users.byoDeepgramKey,
      byoOpenRouterKey: users.byoOpenRouterKey,
    })
    .from(users)
    .where(
      // The first term matches users_byo_keys_idx exactly, so only users who
      // ever saved a key are read.
      sql`(byo_anthropic_key IS NOT NULL OR byo_deepgram_key IS NOT NULL OR byo_openrouter_key IS NOT NULL)
        AND ((${users.byoAnthropicKey} IS NOT NULL AND ${users.byoAnthropicKey} NOT LIKE 'enc:%')
        OR (${users.byoDeepgramKey} IS NOT NULL AND ${users.byoDeepgramKey} NOT LIKE 'enc:%')
        OR (${users.byoOpenRouterKey} IS NOT NULL AND ${users.byoOpenRouterKey} NOT LIKE 'enc:%'))`,
    )
    .limit(200);
  let sealed = 0;
  for (const row of rows) {
    const patch = {
      byoAnthropicKey: await sealSecret(row.byoAnthropicKey),
      byoDeepgramKey: await sealSecret(row.byoDeepgramKey),
      byoOpenRouterKey: await sealSecret(row.byoOpenRouterKey),
    };
    if (![patch.byoAnthropicKey, patch.byoDeepgramKey, patch.byoOpenRouterKey].some(isSealed)) continue;
    await db.update(users).set(patch).where(eq(users.id, row.id));
    sealed += 1;
  }
  return sealed;
}
