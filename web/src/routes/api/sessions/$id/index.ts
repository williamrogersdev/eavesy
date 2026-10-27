import { createFileRoute } from '@tanstack/react-router';
import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetingSegments, meetingUploads } from '@/db/schema';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveIngestActor } from '@/server/device-auth';
import { ownedMeeting } from '@/server/session-ingest';

/** A recording the cloud hasn't finished: what a cancel on the Mac may delete. */
const CANCELLABLE = new Set(['recording', 'queued', 'uploading', 'failed']);

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
      // A recording cancelled on the Mac: the meeting its live segments made
      // goes, the way a delete from the web does. Only an unfinished one, and
      // a device token only the ones its own Mac recorded: it can't delete the
      // rest of the account's meetings. A signed-in web session (no device)
      // can already delete any of its meetings via DELETE /api/meetings/:id.
      DELETE: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });
        if (!CANCELLABLE.has(meeting.status) || (actor.deviceId && meeting.deviceId !== actor.deviceId)) {
          return Response.json({ error: 'not_cancellable' }, { status: 409 });
        }
        const deleted = await meetingsRepo.softDelete(db, { meetingId: meeting.id, userId: actor.userId });
        if (!deleted) return Response.json({ error: 'not_found' }, { status: 404 });
        await activityRepo.log(db, { userId: actor.userId, eventType: 'meeting.delete', meetingId: params.id });
        return Response.json({ ok: true });
      },
    },
  },
});
