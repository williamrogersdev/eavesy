import { createFileRoute } from '@tanstack/react-router';
import { clampLimit } from '@/lib/http/clamp-limit';
import { z } from 'zod';
import { and, asc, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm';
import { type AppDb, getDb } from '@/db/client';
import { devices, meetings, summaries, userNotes } from '@/db/schema';
import * as calendarRepo from '@/db/repo/calendar';
import * as meetingsRepo from '@/db/repo/meetings';
import { EARLY_JOIN_MS, eventBrief, matchEvent } from '@/lib/calendar/match';
import * as projectsRepo from '@/db/repo/projects';
import { isTranscriptionLanguage } from '@/lib/transcription/language';
import { resolveIngestActor } from '@/server/device-auth';
import { guardBurst } from '@/server/rate-limit';

/** Past this offset the list reads as ended, so a client paging through wraps around. */
const MAX_LIST_OFFSET = 100_000;

/** The last time anything another device shows for a meeting changed: its title, summary, transcript or notes. */
const changedAt = sql<number>`max(${meetings.updatedAt}, coalesce(${userNotes.updatedAt}, 0), coalesce(${summaries.generatedAt}, 0), coalesce(${summaries.userEditedAt}, 0))`;

/** What the recording Mac captured: only the microphone (a voice memo or dictation) or the call audio too. */
const captureSource = sql<'mic' | 'mixed' | null>`case
  when exists (select 1 from meeting_segments s where s.meeting_id = ${meetings.id} and s.track = 'system') then 'mixed'
  when exists (select 1 from meeting_segments s where s.meeting_id = ${meetings.id})
    and not exists (select 1 from meeting_segments s where s.meeting_id = ${meetings.id} and s.track <> 'mic') then 'mic'
end`;

const createSessionSchema = z.object({
  clientSessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  language: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((language) => (language && isTranscriptionLanguage(language) ? language : undefined)),
  contextBlurb: z.string().trim().max(4_000).optional(),
  localFolderSlug: z.string().trim().max(200).optional(),
  projectId: z.string().trim().min(1).max(100).optional(),
  archiveFormat: z.enum(['m4a', 'webm', 'opus']).default('m4a'),
  // A Meeting recording (mic and call audio) is linked to the calendar event it falls in.
  kind: z.enum(['meeting']).optional(),
  // When the recording began on the Mac: the session may be created later, after a spell offline.
  startedAt: z.number().int().positive().optional(),
});

/** The Mac's title for a Meeting recording it has not named, which a calendar event's title replaces. */
const UNNAMED_MEETING_TITLE = 'Meeting recording';
/** How far back a client's `startedAt` is believed: further, and the event lookup uses now. */
const STARTED_AT_TRUST_MS = 2 * 24 * 60 * 60 * 1000;

export const Route = createFileRoute('/api/sessions/')({
  server: {
    handlers: {
      // Finished meetings this device did not record, so a second Mac can show them.
      // With changedSince: finished meetings from any device changed after that time,
      // oldest change first, so a Mac can bring edits made elsewhere into its copies.
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const search = new URL(request.url).searchParams;
        const limit = clampLimit(search.get('limit'), 50, 200);
        const offset = Math.max(Math.floor(Number(search.get('offset')) || 0), 0);
        const sinceValue = Math.floor(Number(search.get('changedSince')));
        const since = search.has('changedSince') ? (Number.isFinite(sinceValue) ? Math.max(sinceValue, 0) : 0) : null;
        // With afterId, (changedSince, afterId) is the last meeting the client handled: meetings
        // changed at that same moment with a later id still come, so ties across pages are not lost.
        const afterId = search.get('afterId')?.slice(0, 100) || null;
        if (offset > MAX_LIST_OFFSET) return Response.json({ items: [] });
        const query = getDb()
          .select({
            id: meetings.id,
            title: meetings.title,
            startedAt: meetings.startedAt,
            durationSec: meetings.durationSec,
            source: meetings.source,
            updatedAt: meetings.updatedAt,
            changedAt,
            captureSource,
            deviceId: meetings.deviceId,
            deviceName: devices.name,
          })
          .from(meetings)
          .leftJoin(devices, eq(devices.id, meetings.deviceId))
          .leftJoin(userNotes, eq(userNotes.meetingId, meetings.id))
          .leftJoin(summaries, eq(summaries.meetingId, meetings.id))
          .where(
            and(
              eq(meetings.userId, actor.userId),
              eq(meetings.status, 'complete'),
              isNull(meetings.deletedAt),
              since !== null
                ? afterId
                  ? or(gt(changedAt, since), and(eq(changedAt, since), gt(meetings.id, afterId)))
                  : gt(changedAt, since)
                : actor.deviceId
                  ? or(isNull(meetings.deviceId), ne(meetings.deviceId, actor.deviceId))
                  : undefined,
            ),
          );
        const items = await (since !== null
          ? query.orderBy(asc(changedAt), asc(meetings.id)).limit(limit)
          : query.orderBy(desc(meetings.startedAt), desc(meetings.id)).limit(limit).offset(offset));
        return Response.json({
          items: items.map(({ deviceId, ...item }) => ({
            ...item,
            thisDevice: !!actor.deviceId && deviceId === actor.deviceId,
          })),
        });
      },
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const limited = await guardBurst(actor.userId, 'session-create');
        if (limited) return limited;

        const parsed = createSessionSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }

        const db = getDb();
        const existing = (
          await db
            .select({ id: meetings.id, status: meetings.status })
            .from(meetings)
            .where(
              and(
                eq(meetings.userId, actor.userId),
                eq(meetings.clientSessionId, parsed.data.clientSessionId),
              ),
            )
            .limit(1)
        )[0];
        if (existing) {
          return Response.json({
            meetingId: existing.id,
            nextSegmentIdx: 0,
            nextPartNumber: 1,
            status: existing.status,
            idempotent: true,
          });
        }

        const projectId = parsed.data.projectId && (await projectsRepo.ownsProject(db, actor.userId, parsed.data.projectId))
          ? parsed.data.projectId
          : undefined;
        const event = parsed.data.kind === 'meeting' ? await calendarEventFor(db, actor.userId, parsed.data.startedAt) : null;
        const named = parsed.data.title && parsed.data.title !== UNNAMED_MEETING_TITLE;
        const meetingId = await meetingsRepo.start(db, {
          userId: actor.userId,
          source: actor.deviceId ? 'desktop' : 'web',
          title: event && !named ? event.title : parsed.data.title,
          language: parsed.data.language,
          contextBlurb: event ? [parsed.data.contextBlurb, eventBrief(event)].filter(Boolean).join('\n\n') : parsed.data.contextBlurb,
          calendarEventId: event?.id,
          folderId: projectId,
          localFolderSlug: parsed.data.localFolderSlug,
          deviceId: actor.deviceId,
          clientSessionId: parsed.data.clientSessionId,
          isAnonymous: false,
          audioFormat: parsed.data.archiveFormat,
        });
        if (event) await calendarRepo.markRecorded(db, actor.userId, event.id, meetingId);

        return Response.json(
          { meetingId, nextSegmentIdx: 0, nextPartNumber: 1, status: 'recording' },
          { status: 201 },
        );
      },
    },
  },
});

/** The caller's calendar event a Meeting recording begun at `startedAt` (or now) belongs to. */
async function calendarEventFor(db: AppDb, userId: string, startedAt: number | undefined) {
  const now = Date.now();
  const at = startedAt && startedAt <= now && startedAt > now - STARTED_AT_TRUST_MS ? startedAt : now;
  const events = await calendarRepo.eventsAround(db, userId, at, at + EARLY_JOIN_MS);
  return matchEvent(events, at);
}
