import { createAiRunner } from '@/lib/ai/credit-runner';
import { and, eq, max } from 'drizzle-orm';
import type { R2Bucket } from '@cloudflare/workers-types';
import { dictations, embeddings, meetings, transcriptSegments } from '@/db/schema';
import { embedTexts } from '@/lib/ai/embed';
import { type Db, type ProcessingEnv, chunkText, runBatched } from './shared';
import { transcriptText } from './summarize';
import { consumeRateLimit } from '@/server/rate-limit-store';

/**
 * Edit-triggered re-index runs per meeting per UTC day. Edits coalesce into
 * about one run per five-minute window, so this is hours of steady editing;
 * past it, search catches up on the next day's first edit.
 */
export const EDIT_REINDEX_RUNS_PER_DAY = 48;

export async function handleEmbedMeeting(
  meetingId: string,
  db: Db,
  env: ProcessingEnv,
  opts: { queuedAt?: number } = {},
) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete') return;
  // A re-index queued by an edit is moot once a run that read the transcript
  // after the edit has finished: every edit in a burst queues one, and the
  // first to run covers them all.
  if (opts.queuedAt !== undefined && (await embeddedSince(db, 'meeting', meetingId, opts.queuedAt))) return;
  const cap = { key: `embed-refresh:${meetingId}`, limit: EDIT_REINDEX_RUNS_PER_DAY, windowSec: 24 * 60 * 60, failMode: 'closed' } as const;
  if (opts.queuedAt !== undefined && !(await consumeRateLimit(env.DB, cap)).allowed) {
    console.warn(JSON.stringify({ message: 'edit re-index skipped: daily cap reached', meetingId }));
    return;
  }
  try {
    const readAt = Date.now();
    const segments = await db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, meetingId))
      .orderBy(transcriptSegments.startMs);
    await replaceEmbeddings(db, env, {
      userId: meeting.userId,
      sourceType: 'meeting',
      sourceId: meeting.id,
      text: transcriptText(segments, meeting.speakerNamesJson).text,
      readAt,
    });
  } catch (error) {
    // A run that failed indexed nothing; its retry shouldn't cost a second slot.
    if (opts.queuedAt !== undefined) {
      const day = Math.floor(Date.now() / (cap.windowSec * 1000));
      await env.DB.prepare('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0')
        .bind(`${cap.key}:${day}`).run().catch(() => undefined);
    }
    throw error;
  }
}

export async function handleEmbedDictation(dictationId: string, db: Db, env: ProcessingEnv) {
  const dictation = (
    await db.select().from(dictations).where(eq(dictations.id, dictationId)).limit(1)
  )[0];
  if (!dictation) return;
  await replaceEmbeddings(db, env, {
    userId: dictation.userId,
    sourceType: 'dictation',
    sourceId: dictation.id,
    text: dictation.cleanedText || dictation.transcript,
  });
}

/** Whether a finished run read the source at or after `since` (rows carry their run's read time). */
async function embeddedSince(db: Db, sourceType: 'meeting' | 'dictation', sourceId: string, since: number) {
  const latest = await db
    .select({ at: max(embeddings.createdAt) })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)));
  return (latest[0]?.at ?? 0) >= since;
}

async function replaceEmbeddings(
  db: Db,
  env: ProcessingEnv,
  source: { userId: string; sourceType: 'meeting' | 'dictation'; sourceId: string; text: string; readAt?: number },
) {
  // Rows are stamped with when the text was read, not written: an edit that
  // lands while the model runs is newer than this run, so its re-index runs.
  const readAt = source.readAt ?? Date.now();
  const chunks = chunkText(source.text, 2_000);
  // No text left (every line deleted) still clears what search finds.
  const vectors = chunks.length ? await embedTexts(createAiRunner(env, 'library-embedding'), chunks) : [];
  const previous = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId)));
  const vectorRows = vectors.map((values, chunkIdx) => ({
    id: `${source.sourceId}__${chunkIdx}`,
    values,
    metadata: { userId: source.userId, sourceType: source.sourceType, sourceId: source.sourceId, chunkIdx },
  }));

  // A run that read the text after this one has already written it: this
  // one's text is older, so writing it would put stale words back.
  if (await embeddedSince(db, source.sourceType, source.sourceId, readAt + 1)) return;

  // Vectors first. Their ids are stable per chunk, so an upsert replaces them
  // in place, and only chunks past the new end are deleted. The rows, which
  // carry this run's read time, are written last: a failed upsert leaves the
  // old rows, so the retry is not skipped as already done.
  if (vectorRows.length) await env.VECTORIZE.upsert(vectorRows);
  const kept = new Set(vectorRows.map((row) => row.id));
  const stale = previous.map((row) => row.id).filter((id) => !kept.has(id));
  if (stale.length) await env.VECTORIZE.deleteByIds(stale);
  await runBatched(db, [
    db.delete(embeddings).where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId))),
    ...chunks.map((chunk, chunkIdx) => db.insert(embeddings).values({
      id: vectorRows[chunkIdx].id,
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      chunkIdx,
      contentExcerpt: chunk.slice(0, 280),
      createdAt: readAt,
    })),
  ]);
}

export async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((object) => object.key);
    if (keys.length) await bucket.delete(keys);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function deleteEmbeddings(
  sourceType: 'meeting' | 'dictation',
  sourceId: string,
  db: Db,
  env: ProcessingEnv,
) {
  const rows = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)));
  if (!rows.length) return;
  await env.VECTORIZE.deleteByIds(rows.map((row) => row.id));
  await db.delete(embeddings).where(and(eq(embeddings.sourceType, sourceType), eq(embeddings.sourceId, sourceId)));
}
