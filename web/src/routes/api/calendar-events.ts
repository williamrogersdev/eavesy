import { waitUntil } from 'cloudflare:workers';
import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as calendarRepo from '@/db/repo/calendar';
import { currentAndNext, isMeetingLike } from '@/lib/calendar/match';
import { isDue, syncDue } from '@/server/calendar-sync';
import { resolveIngestActor } from '@/server/device-auth';

/** How far ahead `next` and `upcoming` look. */
const NEXT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The most meetings `upcoming` lists. */
const UPCOMING_LIMIT = 20;

function view(event: calendarRepo.StoredEvent | null) {
  if (!event) return null;
  return {
    id: event.id,
    title: event.title,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    meetingUrl: event.meetingUrl,
    platform: event.platform,
    attendees: event.participants,
    recorded: event.recordedMeetingId !== null,
    recordChoice: event.recordChoice,
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
        return Response.json({ connected: connections.length > 0, current: view(current), next: view(next), upcoming: upcoming.map(view) });
      },
    },
  },
});
