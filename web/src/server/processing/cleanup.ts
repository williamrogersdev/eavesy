import { eq, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import {
  captures,
  dictations,
  drops,
  embeddings,
  meetings,
  meetingSegments,
  meetingUploads,
  users,
} from '@/db/schema';
import { DROP_TTL_MS } from '@/db/repo/drops';
import { type Db, type ProcessingEnv } from './shared';
import { deleteEmbeddings, deletePrefix } from './embed';
import { purgeAccountBots } from '@/server/meeting-bots/service';
import { purgeAccountEmails } from '@/server/email/recaps';

export async function handleCleanup(meetingId: string, db: Db, env: ProcessingEnv) {
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting) return;
  if (meeting.audioR2Key) await env.AUDIO_BUCKET.delete(meeting.audioR2Key);
  const upload = (await db.select().from(meetingUploads).where(eq(meetingUploads.meetingId, meetingId)).limit(1))[0];
  if (upload && upload.state !== 'complete') {
    try {
      await env.AUDIO_BUCKET.resumeMultipartUpload(
        `users/${meeting.userId}/meetings/${meetingId}/audio.${meeting.audioFormat === 'webm' || meeting.audioFormat === 'opus' ? meeting.audioFormat : 'm4a'}`,
        upload.uploadId,
      ).abort();
    } catch {
      // Already completed or expired; nothing left to abort.
    }
  }
  const segmentKeys = await db
    .select({ key: meetingSegments.r2Key })
    .from(meetingSegments)
    .where(eq(meetingSegments.meetingId, meetingId));
  for (let i = 0; i < segmentKeys.length; i += 1000) {
    await env.AUDIO_BUCKET.delete(segmentKeys.slice(i, i + 1000).map((row) => row.key));
  }
  await deletePrefix(env.AUDIO_BUCKET, `users/${meeting.userId}/meetings/${meetingId}/`);
  await deleteEmbeddings('meeting', meetingId, db, env);
  await db.delete(meetings).where(eq(meetings.id, meetingId));
}

export async function handlePurgeAccount(userId: string, db: Db, env: ProcessingEnv) {
  // First, so no bot joins another call for an account that is going away.
  await purgeAccountBots(db, env, userId);
  const owned = await db.select({ id: meetings.id }).from(meetings).where(eq(meetings.userId, userId));
  for (const meeting of owned) await handleCleanup(meeting.id, db, env);

  const vectorIds = await db.select({ id: embeddings.id }).from(embeddings).where(eq(embeddings.userId, userId));
  for (let i = 0; i < vectorIds.length; i += 500) {
    await env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 500).map((row) => row.id));
  }
  await deletePrefix(env.AUDIO_BUCKET, `users/${userId}/`);
  await deletePrefix(env.AUDIO_BUCKET, `anonymous/${userId}/`);

  for (const table of [
    'embeddings',
    'captures',
    'dictations',
    'drops',
    'calendar_events',
    'calendar_connections',
    'speakers',
    'folders',
    'prompt_templates',
    'mcp_tokens',
    'device_tokens',
    'devices',
    'activity_log',
    'subscriptions',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
  }
  await env.DB.prepare('DELETE FROM device_pairing_codes WHERE claimed_by_user_id = ?').bind(userId).run();
  await purgeAccountEmails(db, userId);
  await db.delete(users).where(eq(users.id, userId));
}

export const PURGE_AFTER_MS = 24 * 60 * 60 * 1_000;
export { DROP_TTL_MS };

export async function purgeDeleted(env: ProcessingEnv, now = Date.now()) {
  const db = drizzle(env.DB, { schema });
  const cutoff = now - PURGE_AFTER_MS;

  const deletedMeetings = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(lte(meetings.deletedAt, cutoff))
    .limit(200);
  for (const meeting of deletedMeetings) {
    await env.PROCESSING_QUEUE.send({ kind: 'purge-meeting', meetingId: meeting.id });
  }

  const deletedCaptures = await db
    .select({ id: captures.id, r2Key: captures.r2Key })
    .from(captures)
    .where(lte(captures.deletedAt, cutoff))
    .limit(200);
  for (const capture of deletedCaptures) {
    await env.AUDIO_BUCKET.delete(capture.r2Key);
    await db.delete(captures).where(eq(captures.id, capture.id));
  }

  const deletedDictations = await db
    .select({ id: dictations.id, audioR2Key: dictations.audioR2Key })
    .from(dictations)
    .where(lte(dictations.deletedAt, cutoff))
    .limit(200);
  for (const dictation of deletedDictations) {
    if (dictation.audioR2Key) await env.AUDIO_BUCKET.delete(dictation.audioR2Key);
    await deleteEmbeddings('dictation', dictation.id, db, env);
    await db.delete(dictations).where(eq(dictations.id, dictation.id));
  }

  const expiredDrops = await db
    .select({ id: drops.id, r2Key: drops.r2Key })
    .from(drops)
    .where(lte(drops.createdAt, now - DROP_TTL_MS))
    .limit(500);
  for (const drop of expiredDrops) {
    if (drop.r2Key) await env.AUDIO_BUCKET.delete(drop.r2Key);
    await db.delete(drops).where(eq(drops.id, drop.id));
  }

  return {
    meetings: deletedMeetings.length,
    captures: deletedCaptures.length,
    dictations: deletedDictations.length,
    drops: expiredDrops.length,
  };
}
