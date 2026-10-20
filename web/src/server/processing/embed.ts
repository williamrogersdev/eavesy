import { createAiRunner } from '@/lib/ai/credit-runner';
import { and, eq } from 'drizzle-orm';
import type { R2Bucket } from '@cloudflare/workers-types';
import { dictations, embeddings, meetings, transcriptSegments } from '@/db/schema';
import { embedTexts } from '@/lib/ai/embed';
import { type Db, type ProcessingEnv, chunkText, runBatched } from './shared';
import { transcriptText } from './summarize';

export async function handleEmbedMeeting(meetingId: string, db: Db, env: ProcessingEnv) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete') return;
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
  });
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

async function replaceEmbeddings(
  db: Db,
  env: ProcessingEnv,
  source: { userId: string; sourceType: 'meeting' | 'dictation'; sourceId: string; text: string },
) {
  const chunks = chunkText(source.text, 2_000);
  if (chunks.length === 0) return;
  const vectors = await embedTexts(createAiRunner(env, 'library-embedding'), chunks);
  const previous = await db
    .select({ id: embeddings.id })
    .from(embeddings)
    .where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId)));
  if (previous.length > 0) await env.VECTORIZE.deleteByIds(previous.map((row) => row.id));
  await db
    .delete(embeddings)
    .where(and(eq(embeddings.sourceType, source.sourceType), eq(embeddings.sourceId, source.sourceId)));

  const now = Date.now();
  const vectorRows = vectors.map((values, chunkIdx) => ({
    id: `${source.sourceId}__${chunkIdx}`,
    values,
    metadata: { userId: source.userId, sourceType: source.sourceType, sourceId: source.sourceId, chunkIdx },
  }));
  await runBatched(db, chunks.map((chunk, chunkIdx) =>
    db.insert(embeddings).values({
      id: vectorRows[chunkIdx].id,
      userId: source.userId,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      chunkIdx,
      contentExcerpt: chunk.slice(0, 280),
      createdAt: now,
    }),
  ));
  await env.VECTORIZE.upsert(vectorRows);
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
