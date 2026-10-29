import { and, desc, eq, getTableColumns, inArray, isNull, lt, max } from 'drizzle-orm';
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
    folderId?: string;
    calendarEventId?: string;
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
    folderId: args.folderId,
    calendarEventId: args.calendarEventId,
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

  return {
    meeting,
    summary: summaryRow[0] ? decodeSummary(summaryRow[0]) : null,
    notes: notesRow[0] ?? null,
    segments,
    // Where a live transcript stream should resume from after this read.
    transcriptCursor: segmentStamp[0]?.at ?? 0,
  };
}

function decodeSummary(row: typeof summaries.$inferSelect) {
  return {
    id: row.id,
    meetingId: row.meetingId,
    tldr: row.tldr,
    decisions: decode<Decision[]>(row.decisionsJson, []),
    actionItems: decode<ActionItem[]>(row.actionItemsJson, []),
    followUps: decode<Sourced[]>(row.followUpsJson, []),
    openQuestions: decode<Sourced[]>(row.openQuestionsJson, []),
    topics: decode<string[]>(row.topicsJson, []),
    mentions: decode<Mention[]>(row.mentionsJson, []),
    chapters: decode<{ startMs: number; title: string }[]>(row.chaptersJson, []),
    generatedByModel: row.generatedByModel,
    generatedAt: row.generatedAt,
    userEditedAt: row.userEditedAt,
  };
}

/** Meetings read per round trip by `listFullForUser`; keeps each IN list well under D1's bound-parameter limit. */
export const FULL_MEETING_CHUNK = 50;

/**
 * Every live meeting of a user with its summary, notes and transcript, the
 * same shape as `getFull`, read `FULL_MEETING_CHUNK` meetings per D1 batch
 * instead of one batch per meeting. Yields one chunk at a time so a caller
 * can write each out before the next is read.
 */
export async function* listFullForUser(db: AppDb, args: { userId: string; limit?: number }) {
  const ids = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.userId, args.userId), isNull(meetings.deletedAt)))
    .orderBy(desc(meetings.startedAt))
    .limit(args.limit ?? 10_000);
  for (let i = 0; i < ids.length; i += FULL_MEETING_CHUNK) {
    const chunk = ids.slice(i, i + FULL_MEETING_CHUNK).map((row) => row.id);
    const [meetingRows, summaryRows, notesRows, segmentRows] = await db.batch([
      db
        .select({ ...getTableColumns(meetings), deviceName: devices.name })
        .from(meetings)
        .leftJoin(devices, eq(devices.id, meetings.deviceId))
        .where(and(inArray(meetings.id, chunk), eq(meetings.userId, args.userId), isNull(meetings.deletedAt)))
        .orderBy(desc(meetings.startedAt)),
      db.select().from(summaries).where(inArray(summaries.meetingId, chunk)),
      db.select().from(userNotes).where(inArray(userNotes.meetingId, chunk)),
      db
        .select()
        .from(transcriptSegments)
        .where(inArray(transcriptSegments.meetingId, chunk))
        .orderBy(transcriptSegments.meetingId, transcriptSegments.startMs),
    ]);
    const summaryBy = new Map(summaryRows.map((row) => [row.meetingId, row]));
    const notesBy = new Map(notesRows.map((row) => [row.meetingId, row]));
    const segmentsBy = new Map<string, (typeof segmentRows)[number][]>();
    for (const segment of segmentRows) {
      const list = segmentsBy.get(segment.meetingId);
      if (list) list.push(segment);
      else segmentsBy.set(segment.meetingId, [segment]);
    }
    yield meetingRows.map((meeting) => {
      const summary = summaryBy.get(meeting.id);
      return {
        meeting,
        summary: summary ? decodeSummary(summary) : null,
        notes: notesBy.get(meeting.id) ?? null,
        segments: segmentsBy.get(meeting.id) ?? [],
        transcriptCursor: 0,
      };
    });
  }
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
