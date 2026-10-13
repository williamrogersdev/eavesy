import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveActor } from '@/server/auth';

export const Route = createFileRoute('/api/meetings/$id/copy')({
  server: {
    handlers: {
      POST: async ({ params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const db = getDb();
        const meeting = await meetingsRepo.get(db, {
          meetingId: params.id,
          userId: actor.userId,
        });
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.copy',
          meetingId: meeting.id,
          metadata: { format: 'context-markdown' },
        });
        return new Response(null, { status: 204 });
      },
    },
  },
});
