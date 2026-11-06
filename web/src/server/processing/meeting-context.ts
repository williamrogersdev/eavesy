import { and, desc, eq, gt, isNull, lt, ne, or } from 'drizzle-orm';
import { calendarEvents, meetings, summaries, users } from '@/db/schema';
import { decode } from '@/db/codec';
import {
  attendeesFrom,
  sameCrowd,
  type MeetingContext,
  type PreviousMeeting,
} from '@/lib/meetings/meeting-context';
import type { Db } from './shared';

/** How far back the last meeting with the same people is looked for. */
const PREVIOUS_WITHIN_MS = 120 * 24 * 60 * 60 * 1_000;
/** Earlier calendar meetings compared, newest first. */
const PREVIOUS_CANDIDATES = 40;

type MeetingRef = { id: string; userId: string; calendarEventId: string | null; startedAt: number };

/**
 * The calendar's context for a meeting linked to an event: by the event the
 * recording started from, or the one it was later marked as recording. Null
 * for a meeting with no event. `previous` also finds the last meeting with
 * the same people; transcription doesn't need it, the notes do.
 */
export async function loadMeetingContext(
  db: Db,
  meeting: MeetingRef,
  opts: { previous?: boolean } = {},
): Promise<MeetingContext | null> {
  const event = (
    await db
      .select({ id: calendarEvents.id, providerEventId: calendarEvents.providerEventId, title: calendarEvents.title, participantsJson: calendarEvents.participantsJson, description: calendarEvents.description })
      .from(calendarEvents)
      .where(and(
        eq(calendarEvents.userId, meeting.userId),
        meeting.calendarEventId
          ? or(eq(calendarEvents.id, meeting.calendarEventId), eq(calendarEvents.recordedMeetingId, meeting.id))
          : eq(calendarEvents.recordedMeetingId, meeting.id),
      ))
      .limit(1)
  )[0];
  if (!event) return null;
  const owner = (await db.select({ email: users.email }).from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  const attendees = attendeesFrom(decode<unknown[]>(event.participantsJson, []), owner?.email);
  const context: MeetingContext = { title: event.title, attendees, agenda: event.description, previous: null };
  if (opts.previous) context.previous = await previousMeeting(db, meeting, event, context, owner?.email);
  return context;
}

/**
 * The newest finished meeting before this one, from the calendar, with the
 * same people (or, for a recurring meeting, the same title), that has notes.
 */
async function previousMeeting(
  db: Db,
  meeting: MeetingRef,
  event: { id: string; providerEventId: string },
  context: MeetingContext,
  ownerEmail: string | null | undefined,
): Promise<PreviousMeeting | null> {
  const emails = context.attendees.map((person) => person.email);
  const candidates = await db
    .select({
      id: meetings.id,
      title: meetings.title,
      startedAt: meetings.startedAt,
      eventTitle: calendarEvents.title,
      participantsJson: calendarEvents.participantsJson,
    })
    .from(meetings)
    .innerJoin(calendarEvents, eq(calendarEvents.id, meetings.calendarEventId))
    .where(and(
      eq(meetings.userId, meeting.userId),
      ne(meetings.id, meeting.id),
      // Not this meeting's twin: the Notetaker's copy, or the same invite on another connected account.
      ne(calendarEvents.id, event.id),
      ne(calendarEvents.providerEventId, event.providerEventId),
      eq(meetings.status, 'complete'),
      isNull(meetings.deletedAt),
      lt(meetings.startedAt, meeting.startedAt),
      gt(meetings.startedAt, meeting.startedAt - PREVIOUS_WITHIN_MS),
    ))
    .orderBy(desc(meetings.startedAt))
    .limit(PREVIOUS_CANDIDATES);
  const title = context.title.trim().toLowerCase();
  for (const candidate of candidates) {
    const theirs = attendeesFrom(decode<unknown[]>(candidate.participantsJson, []), ownerEmail).map((p) => p.email);
    const recurring = title !== '(no title)' && candidate.eventTitle.trim().toLowerCase() === title && emails.length > 0;
    if (!sameCrowd(emails, theirs) && !recurring) continue;
    const summary = (await db.select({ tldr: summaries.tldr }).from(summaries).where(eq(summaries.meetingId, candidate.id)).limit(1))[0];
    if (!summary?.tldr.trim()) continue;
    return { title: candidate.title, startedAt: candidate.startedAt, tldr: summary.tldr };
  }
  return null;
}
