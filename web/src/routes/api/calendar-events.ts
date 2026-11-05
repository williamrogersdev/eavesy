import { waitUntil } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { currentAndNext, isMeetingLike } from '@/lib/calendar/match';
import { isDue, syncDue } from '@/server/calendar-sync';
import { resolveIngestActor } from '@/server/device-auth';
import { eq } from 'drizzle-orm';
import { users } from '@/db/schema';
import { type CaptureDefault, effectiveMode, legacyRecordChoice } from '@/lib/meetings/capture-plan';
import { joinableMeeting } from '@/server/meeting-bots/service';

/** How far ahead `next` and `upcoming` look. */
const NEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most meetings `upcoming` lists. */
const UPCOMING_LIMIT = 20;

function view(event: calendarRepo.StoredEvent | null, accountDefault: CaptureDefault) {
  if (!event) return null;
  // The same test the plan uses to send a bot.
  const notetakerCanJoin = joinableMeeting(event.meetingUrl) !== null;
  return {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    meetingUrl: event.meetingUrl,
    platform: event.platform,
    attendees: event.participants,
    recorded: event.recordedMeetingId !== null,
    // What Mac apps from before capture modes read: never record a Notetaker-only meeting.
    recordChoice: legacyRecordChoice(event.captureMode, accountDefault, notetakerCanJoin),
    // This meeting's own choice (null: the account default), and the plan it ends up with.
    captureMode: event.captureMode,
    mode: effectiveMode(event.captureMode, accountDefault, notetakerCanJoin),
    notetakerCanJoin,
  };
}

// The Mac app asks this (with its device token) for the meeting under way and
// the next one, so the launcher can name what a Meeting recording will be
// linked to. `current` is exactly the event a recording started now would join;
// `upcoming` lists the meetings ahead, each with whether to record it.
export const Route = createFileRoute('/api/calendar-events')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const now = Date.now();
        const connections = await calendarRepo.listConnections(db, actor.userId);
        // Answer from what's stored and refresh stale calendars after the response.
        if (connections.some((row) => isDue(row, now))) waitUntil(syncDue(db, connections, now));
        const events = connections.length ? await calendarRepo.eventsAround(db, actor.userId, now, now + NEXT_WINDOW_MS) : [];
        const { current, next } = currentAndNext(events, now);
        const upcoming = events.filter((event) => isMeetingLike(event) && event.endsAt > now).slice(0, UPCOMING_LIMIT);
        const accountDefault = (await db.select({ mode: users.meetingCaptureDefault }).from(users).where(eq(users.id, actor.userId)).limit(1))[0]?.mode ?? 'mac';
        const show = (event: calendarRepo.StoredEvent | null) => view(event, accountDefault);
        return Response.json({
          connected: connections.length > 0,
          captureDefault: accountDefault,
          current: show(current),
          next: show(next),
          upcoming: upcoming.map(show),
        });
      },
    },
  },
});
