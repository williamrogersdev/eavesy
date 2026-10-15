import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { liveTranscriptJson, requestedCursor } from '@/server/live-transcript';
import { guardBurst } from '@/server/rate-limit';
import { ownedMeeting } from '@/server/session-ingest';

/**
 * The desktop app's view of `/api/meetings/:id/transcript`: transcript changes
 * since `?since=` for a recording it uploaded, so it can swap its on-device
 * captions for cloud lines while still recording. JSON only; it polls.
 *
 * A missing or deleted meeting answers 404 with `error: 'meeting_not_found'`,
 * so the app can tell it from a server that predates this route (a 404 without
 * that code) and stop polling only that recording.
 */
export const Route = createFileRoute('/api/sessions/$id/transcript')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const limited = await guardBurst(actor.userId, 'live-transcript');
        if (limited) return limited;
        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'meeting_not_found' }, { status: 404 });
        return liveTranscriptJson(db, meeting.id, requestedCursor(request));
      },
    },
  },
});
