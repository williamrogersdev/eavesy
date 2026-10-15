import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveActor } from '@/server/auth';
import {
  liveTranscriptJson,
  liveTranscriptStream,
  requestedCursor,
  wantsEventStream,
} from '@/server/live-transcript';

/**
 * Transcript changes since a cursor (`?since=`, or Last-Event-ID). Asked for
 * as `text/event-stream` it streams them as they are transcribed; otherwise it
 * answers once with JSON, for clients that poll.
 */
export const Route = createFileRoute('/api/meetings/$id/transcript')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const url = new URL(request.url);
        let actor;
        try {
          actor = await resolveActor({
            anonymousSessionToken:
              request.headers.get('x-anonymous-token') ?? url.searchParams.get('anonymousSessionToken'),
          });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const meeting = await meetingsRepo.get(db, { meetingId: params.id, userId: actor.userId });
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });
        const since = requestedCursor(request);
        return wantsEventStream(request)
          ? liveTranscriptStream(db, meeting.id, since)
          : liveTranscriptJson(db, meeting.id, since);
      },
    },
  },
});
