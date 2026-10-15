import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { resolveIngestActor } from '@/server/device-auth';
import { liveTranscriptJson, requestedCursor } from '@/server/live-transcript';
import { ownedMeeting } from '@/server/session-ingest';

/**
 * The desktop app's view of `/api/meetings/:id/transcript`: transcript changes
 * since `?since=` for a recording it uploaded, so it can swap its on-device
 * captions for cloud lines while still recording. JSON only; it polls.
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
        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });
        return liveTranscriptJson(db, meeting.id, requestedCursor(request));
      },
    },
  },
});
