import { and, desc, eq, getTableColumns, isNull, lt, max } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { devices, meetingSegments, meetings, transcriptSegments, summaries, userNotes } from '../schema';
import { transcriptionLanguage } from './users';
import {
  decode,
  type ActionItem,
  type Decision,
  type Mention,
  type Sourced,
} from '../codec';

export type MeetingStatus = (typeof meetings.$inferSelect)['status'];
export type MeetingSource = (typeof meetings.$inferSelect)['source'];

export async function start(
  db: AppDb,
  args: {
    userId: string;
    source: MeetingSource;
    title?: string;
    language?: string;
    localFolderSlug?: string;
    deviceId?: string;
    clientSessionId?: string;
    contextBlurb?: string;
    isAnonymous: boolean;
    audioFormat?: 'm4a' | 'webm' | 'opus';
  },
): Promise<string> {
  const id = pid('meet');
  const now = Date.now();
  await db.insert(meetings).values({
    id,
    userId: args.userId,
    title: args.title ?? 'Recording in progress…',
    description: '',
    startedAt: now,
    source: args.source,
    language: args.language ?? (await transcriptionLanguage(db, args.userId)),
    status: 'recording',
    localFolderSlug: args.localFolderSlug,
    deviceId: args.deviceId,
    clientSessionId: args.clientSessionId,
    contextBlurb: args.contextBlurb,
    audioFormat: args.audioFormat,
    expiresAt: args.isAnonymous ? now + 24 * 60 * 60 * 1000 : null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function finalize(
  db: AppDb,
  args: {
    meetingId: string;
    userId: string;
    endedAt: number;
    durationSec: number;
    audioR2Key?: string;
    audioBytes?: number;
    audioDurationSec?: number;
    audioFormat?: 'm4a' | 'opus' | 'wav' | 'mp3' | 'webm';
  },
): Promise<void> {
  await db
    .update(meetings)
    .set({
      endedAt: args.endedAt,
      durationSec: args.durationSec,
      audioR2Key: args.audioR2Key,
      audioBytes: args.audioBytes,
      audioDurationSec: args.audioDurationSec,
      audioFormat: args.audioFormat,
      updatedAt: Date.now(),
    })
    .where(and(eq(meetings.id, args.meetingId), eq(meetings.userId, args.userId)));
}

export async function update(
  db: AppDb,
  args: {
    meetingId: string;
    userId: string;
    title?: string;
    description?: string;
    status?: MeetingStatus;
    statusError?: string | null;
    localFolderSlug?: string;
    folderId?: string | null;
    platform?: (typeof meetings.$inferSelect)['platform'];
    speakerNamesJson?: string | null;
  },
): Promise<boolean> {
  const patch: Partial<typeof meetings.$inferInsert> = { updatedAt: Date.now() };
  if (args.title !== undefined) patch.title = args.title;
  if (args.description !== undefined) patch.description = args.description;
  if (args.status !== undefined) patch.status = args.status;
  if (args.statusError !== undefined) patch.statusError = args.statusError;
  if (args.localFolderSlug !== undefined) patch.localFolderSlug = args.localFolderSlug;
  if (args.folderId !== undefined) patch.folderId = args.folderId;
  if (args.platform !== undefined) patch.platform = args.platform;
  if (args.speakerNamesJson !== undefined) patch.speakerNamesJson = args.speakerNamesJson;
  const updated = await db
    .update(meetings)
    .set(patch)
    .where(and(eq(meetings.id, args.meetingId), eq(meetings.userId, args.userId)))
    .returning({ id: meetings.id });
  return updated.length > 0;
}

export async function softDelete(db: AppDb, args: { meetingId: string; userId: string }): Promise<boolean> {
  const deleted = await db
    .update(meetings)
    .set({ deletedAt: Date.now(), updatedAt: Date.now() })
    .where(and(eq(meetings.id, args.meetingId), eq(meetings.userId, args.userId)))
    .returning({ id: meetings.id });
  return deleted.length > 0;
}

export async function get(db: AppDb, args: { meetingId: string; userId: string }) {
  const rows = await db
    .select()
    .from(meetings)
    .where(
      and(
        eq(meetings.id, args.meetingId),
        eq(meetings.userId, args.userId),
        isNull(meetings.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listForUser(db: AppDb, args: { userId: string; limit?: number }) {
  return await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.userId, args.userId), isNull(meetings.deletedAt)))
    .orderBy(desc(meetings.startedAt))
    .limit(args.limit ?? 50);
}

export async function listSummariesForUser(
  db: AppDb,
  args: { userId: string; limit?: number; before?: number },
) {
  return await db
    .select({
      id: meetings.id,
      title: meetings.title,
      description: meetings.description,
      startedAt: meetings.startedAt,
      endedAt: meetings.endedAt,
      durationSec: meetings.durationSec,
      source: meetings.source,
      platform: meetings.platform,
      deviceName: devices.name,
      status: meetings.status,
      folderId: meetings.folderId,
      createdAt: meetings.createdAt,
      updatedAt: meetings.updatedAt,
    })
    .from(meetings)
    .leftJoin(devices, eq(devices.id, meetings.deviceId))
    .where(
      and(
        eq(meetings.userId, args.userId),
        isNull(meetings.deletedAt),
        args.before === undefined ? undefined : lt(meetings.startedAt, args.before),
      ),
    )
    .orderBy(desc(meetings.startedAt))
    .limit(args.limit ?? 50);
}

export async function getFull(db: AppDb, args: { meetingId: string; userId: string }) {
  const [meetingRows, summaryRow, notesRow, segments, segmentStamp] = await db.batch([
    db
      .select({ ...getTableColumns(meetings), deviceName: devices.name })
      .from(meetings)
      .leftJoin(devices, eq(devices.id, meetings.deviceId))
      .where(
        and(
          eq(meetings.id, args.meetingId),
          eq(meetings.userId, args.userId),
          isNull(meetings.deletedAt),
        ),
      )
      .limit(1),
    db
      .select()
      .from(summaries)
      .where(eq(summaries.meetingId, args.meetingId))
      .limit(1),
    db
      .select()
      .from(userNotes)
      .where(eq(userNotes.meetingId, args.meetingId))
      .limit(1),
    db
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, args.meetingId))
      .orderBy(transcriptSegments.startMs),
    db
      .select({ at: max(meetingSegments.transcribedAt) })
      .from(meetingSegments)
      .where(eq(meetingSegments.meetingId, args.meetingId)),
  ]);
  const meeting = meetingRows[0];
  if (!meeting) return null;

  const summary = summaryRow[0]
    ? {
        id: summaryRow[0].id,
        meetingId: summaryRow[0].meetingId,
        tldr: summaryRow[0].tldr,
        decisions: decode<Decision[]>(summaryRow[0].decisionsJson, []),
        actionItems: decode<ActionItem[]>(summaryRow[0].actionItemsJson, []),
        followUps: decode<Sourced[]>(summaryRow[0].followUpsJson, []),
        openQuestions: decode<Sourced[]>(summaryRow[0].openQuestionsJson, []),
        topics: decode<string[]>(summaryRow[0].topicsJson, []),
        mentions: decode<Mention[]>(summaryRow[0].mentionsJson, []),
        chapters: decode<{ startMs: number; title: string }[]>(summaryRow[0].chaptersJson, []),
        generatedByModel: summaryRow[0].generatedByModel,
        generatedAt: summaryRow[0].generatedAt,
        userEditedAt: summaryRow[0].userEditedAt,
      }
    : null;

  return {
    meeting,
    summary,
    notes: notesRow[0] ?? null,
    segments,
    // Where a live transcript stream should resume from after this read.
    transcriptCursor: segmentStamp[0]?.at ?? 0,
  };
}

export async function getByShareSlug(db: AppDb, slug: string) {
  const rows = await db.select().from(meetings).where(eq(meetings.shareSlug, slug)).limit(1);
  const meeting = rows[0];
  if (!meeting || meeting.deletedAt) return null;
  if (meeting.shareExpiresAt && meeting.shareExpiresAt < Date.now()) return null;
  return meeting;
}

export async function findExpiredAnonymous(db: AppDb, limit = 500) {
  return await db
    .select()
    .from(meetings)
    .where(and(lt(meetings.expiresAt, Date.now())))
    .limit(limit);
}

export async function hardDelete(db: AppDb, meetingId: string) {
  await db.delete(meetings).where(eq(meetings.id, meetingId));
}
