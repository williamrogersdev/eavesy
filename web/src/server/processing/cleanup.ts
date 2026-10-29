import { eq, inArray, lte } from 'drizzle-orm';
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
import { RETAIN_MS as AGENT_MESSAGE_RETAIN_MS } from '@/server/agent-inbox';
import { type Db, type ProcessingEnv, runBatched } from './shared';
import { deleteEmbeddings, deletePrefix } from './embed';
import { chunked, D1_IN_LIST_SIZE, sendMessages } from './queue-batch';
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

  // Every table whose user_id references users, children first: D1 enforces
  // foreign keys, so one missed table fails the final delete for good.
  // (meeting_bots and email_deliveries are cleared above and below.)
  for (const table of ACCOUNT_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
  }
  await env.DB.prepare('DELETE FROM device_pairing_codes WHERE claimed_by_user_id = ?').bind(userId).run();
  await purgeAccountEmails(db, userId);
  await db.delete(users).where(eq(users.id, userId));
}

/** Tables purged by user_id when an account is deleted; exported for the test that checks none is missing. */
export const ACCOUNT_TABLES = [
  'recording_imports',
  'embeddings',
  'captures',
  'dictations',
  'drops',
  'calendar_events',
  'calendar_connections',
  'speakers',
  'folders',
  'prompt_templates',
  'saved_prompts',
  'agent_messages',
  'agent_feedback',
  'agent_listeners',
  'personal_dictionary',
  'webhook_endpoints',
  'mcp_tokens',
  'oauth_codes',
  'device_tokens',
  'devices',
  'activity_log',
  'subscriptions',
] as const;

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
  await sendMessages(
    env.PROCESSING_QUEUE,
    deletedMeetings.map((meeting) => ({ kind: 'purge-meeting', meetingId: meeting.id })),
    'deleted meeting purge',
  );

  // Objects first, rows after: if an R2 delete fails, the rows are still
  // there for the next run to find.
  const deletedCaptures = await db
    .select({ id: captures.id, r2Key: captures.r2Key })
    .from(captures)
    .where(lte(captures.deletedAt, cutoff))
    .limit(200);
  await deleteObjects(env, deletedCaptures.map((capture) => capture.r2Key));
  await deleteRows(db, captures, captures.id, deletedCaptures.map((capture) => capture.id));

  const deletedDictations = await db
    .select({ id: dictations.id, audioR2Key: dictations.audioR2Key })
    .from(dictations)
    .where(lte(dictations.deletedAt, cutoff))
    .limit(200);
  await deleteObjects(env, deletedDictations.map((dictation) => dictation.audioR2Key));
  for (const dictation of deletedDictations) await deleteEmbeddings('dictation', dictation.id, db, env);
  await deleteRows(db, dictations, dictations.id, deletedDictations.map((dictation) => dictation.id));

  const expiredDrops = await db
    .select({ id: drops.id, r2Key: drops.r2Key })
    .from(drops)
    .where(lte(drops.createdAt, now - DROP_TTL_MS))
    .limit(500);
  await deleteObjects(env, expiredDrops.map((drop) => drop.r2Key));
  await deleteRows(db, drops, drops.id, expiredDrops.map((drop) => drop.id));

  // Agent messages are only useful while someone waits on them.
  const oldMessages = await env.DB.prepare('DELETE FROM agent_messages WHERE expires_at <= ?').bind(now - AGENT_MESSAGE_RETAIN_MS).run();
  await env.DB.prepare('DELETE FROM agent_listeners WHERE seen_at <= ?').bind(now - AGENT_MESSAGE_RETAIN_MS).run();

  return {
    meetings: deletedMeetings.length,
    captures: deletedCaptures.length,
    dictations: deletedDictations.length,
    drops: expiredDrops.length,
    agentMessages: oldMessages.meta.changes ?? 0,
  };
}

/** R2 deletes up to 1,000 keys per call. */
async function deleteObjects(env: ProcessingEnv, keys: (string | null)[]) {
  const present = keys.filter((key): key is string => Boolean(key));
  for (const chunk of chunked(present, 1_000)) await env.AUDIO_BUCKET.delete(chunk);
}

async function deleteRows(
  db: Db,
  table: typeof captures | typeof dictations | typeof drops,
  id: typeof captures.id | typeof dictations.id | typeof drops.id,
  ids: string[],
) {
  const statements = chunked(ids, D1_IN_LIST_SIZE).map((chunk) => db.delete(table).where(inArray(id, chunk)));
  if (statements.length) await runBatched(db, statements);
}
