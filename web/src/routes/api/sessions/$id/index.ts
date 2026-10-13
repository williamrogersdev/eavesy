import { createFileRoute } from '@tanstack/react-router';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetingSegments, meetingUploads } from '@/db/schema';
import { resolveIngestActor } from '@/server/device-auth';
import { ownedMeeting } from '@/server/session-ingest';

export const Route = createFileRoute('/api/sessions/$id/')({
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

        const [segmentState, upload] = await Promise.all([
          db
            .select({ next: sql<number>`coalesce(max(${meetingSegments.idx}) + 1, 0)` })
            .from(meetingSegments)
            .where(eq(meetingSegments.meetingId, meeting.id)),
          db
            .select()
            .from(meetingUploads)
            .where(and(eq(meetingUploads.meetingId, meeting.id), eq(meetingUploads.state, 'active')))
            .limit(1),
        ]);

        return Response.json({
          meetingId: meeting.id,
          nextSegmentIdx: segmentState[0]?.next ?? 0,
          nextPartNumber: upload[0]?.nextPartNumber ?? 1,
          status: meeting.status,
          contextBlurb: meeting.contextBlurb,
        });
      },
    },
  },
});
