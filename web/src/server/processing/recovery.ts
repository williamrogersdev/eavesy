import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import { meetingSegments, users } from '@/db/schema';
import { reportError } from '@/server/observability';
import { isSealed, sealSecret } from '@/server/secret-box';
import { type ProcessingEnv, SEGMENT_CLAIM_TTL_MS } from './shared';

const STALE_SEGMENT_SWEEP_LIMIT = 100;

/**
 * Queue segments whose transcription claim outlived any possible consumer.
 * Without this, a segment whose worker died after its queue message gave up
 * would stay 'processing' and leave a gap in the transcript.
 *
 * Each row is sent first and reset to 'pending' only after its send succeeds,
 * so a failed send leaves the row stale for the next sweep. Failures are
 * reported, never thrown: the rest of the cron must still run.
 */
export async function recoverStaleSegments(env: ProcessingEnv, now = Date.now()) {
  const db = drizzle(env.DB, { schema });
  const stale = and(
    eq(meetingSegments.transcribeStatus, 'processing'),
    or(isNull(meetingSegments.transcribeClaimedAt), lt(meetingSegments.transcribeClaimedAt, now - SEGMENT_CLAIM_TTL_MS)),
  );
  let candidates;
  try {
    candidates = await db
      .select({
        id: meetingSegments.id,
        meetingId: meetingSegments.meetingId,
        idx: meetingSegments.idx,
        track: meetingSegments.track,
      })
      .from(meetingSegments)
      .where(stale)
      .limit(STALE_SEGMENT_SWEEP_LIMIT);
  } catch (error) {
    reportError('could not look up stale segment claims', error);
    return;
  }
  let requeued = 0;
  for (const { id, ...segment } of candidates) {
    try {
      await env.PROCESSING_QUEUE.send({ kind: 'transcribe-segment', ...segment });
      // Conditional on still being stale: if the message was already picked up
      // and claimed, the fresh claim is left alone.
      await db
        .update(meetingSegments)
        .set({ transcribeStatus: 'pending', transcribeClaimedAt: null })
        .where(and(eq(meetingSegments.id, id), stale));
      requeued += 1;
    } catch (error) {
      reportError('could not requeue stale segment claim', error, { segment });
    }
  }
  if (candidates.length > 0) {
    console.warn(
      JSON.stringify({ message: 'requeued stale segment claims', count: requeued, failed: candidates.length - requeued }),
    );
  }
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
