import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetingUploads, meetings } from '@/db/schema';
import { resolveIngestActor } from '@/server/device-auth';
import { loadOrCreateMultipart, parseUploadedParts } from '@/server/multipart-state';
import { archiveFormatOf, bucket, meetingArchiveKey } from '@/server/r2';
import { ARCHIVE_PART_SIZE, boundedInteger, ownedMeeting } from '@/server/session-ingest';

export const Route = createFileRoute('/api/sessions/$id/parts/$n')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const partNumber = boundedInteger(params.n, { min: 1, max: 9_999 });
        const contentLength = boundedInteger(request.headers.get('content-length'), {
          min: ARCHIVE_PART_SIZE,
          max: ARCHIVE_PART_SIZE,
        });
        if (partNumber === null || contentLength === null) {
          return Response.json(
            { error: 'archive parts must be exactly 8 MiB and include Content-Length' },
            { status: 400 },
          );
        }

        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        const state = await loadOrCreateMultipart(db, {
          meetingId: meeting.id,
          userId: actor.userId,
          format: archiveFormatOf(meeting),
        });
        if (state.state !== 'active') {
          return Response.json({ error: 'archive_not_active' }, { status: 409 });
        }
        if (partNumber < state.nextPartNumber) {
          return Response.json({ ok: true, idempotent: true, nextPartNumber: state.nextPartNumber });
        }
        if (partNumber !== state.nextPartNumber) {
          return Response.json(
            { error: 'part_out_of_order', nextPartNumber: state.nextPartNumber },
            { status: 409 },
          );
        }

        const multipart = bucket().resumeMultipartUpload(
          meetingArchiveKey(actor.userId, meeting.id, archiveFormatOf(meeting)),
          state.uploadId,
        );
        const uploaded = await multipart.uploadPart(partNumber, await request.arrayBuffer());
        const parts = parseUploadedParts(state.etagsJson);
        parts.push({ partNumber, etag: uploaded.etag, bytes: contentLength });

        const updated = await db
          .update(meetingUploads)
          .set({
            nextPartNumber: partNumber + 1,
            etagsJson: JSON.stringify(parts),
            updatedAt: Date.now(),
          })
          .where(
            and(
              eq(meetingUploads.meetingId, meeting.id),
              eq(meetingUploads.nextPartNumber, partNumber),
              eq(meetingUploads.state, 'active'),
            ),
          )
          .returning({ nextPartNumber: meetingUploads.nextPartNumber });
        if (updated.length === 0) {
          return Response.json({ error: 'part_conflict' }, { status: 409 });
        }

        await db
          .update(meetings)
          .set({ status: 'uploading', updatedAt: Date.now() })
          .where(eq(meetings.id, meeting.id));
        return Response.json({ ok: true, nextPartNumber: partNumber + 1 });
      },
    },
  },
});
