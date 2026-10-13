import { createFileRoute } from '@tanstack/react-router';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { meetingSegments, meetingUploads, meetings } from '@/db/schema';
import { resolveIngestActor } from '@/server/device-auth';
import { loadOrCreateMultipart, parseUploadedParts } from '@/server/multipart-state';
import { enqueue } from '@/server/queue';
import { archiveFormatOf, bucket, meetingArchiveKey } from '@/server/r2';
import { ARCHIVE_PART_SIZE, ownedMeeting } from '@/server/session-ingest';

export const Route = createFileRoute('/api/sessions/$id/finalize/')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const finalBytes = new Uint8Array(await request.arrayBuffer());
        if (finalBytes.byteLength === 0 || finalBytes.byteLength > ARCHIVE_PART_SIZE) {
          return Response.json({ error: 'invalid_final_part' }, { status: 400 });
        }

        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });
        if (meeting.audioR2Key && ['processing', 'complete'].includes(meeting.status)) {
          if (meeting.status === 'processing') {
            await enqueue({ kind: 'summarize', meetingId: meeting.id });
          }
          return Response.json({ ok: true, idempotent: true, status: meeting.status });
        }

        let state = await loadOrCreateMultipart(db, {
          meetingId: meeting.id,
          userId: actor.userId,
          format: archiveFormatOf(meeting),
        });
        if (state.state === 'failed') {
          return Response.json({ error: 'archive_not_active' }, { status: 409 });
        }

        const key = meetingArchiveKey(actor.userId, meeting.id, archiveFormatOf(meeting));
        const parts = parseUploadedParts(state.etagsJson);
        if (state.state === 'active') {
          const multipart = bucket().resumeMultipartUpload(key, state.uploadId);
          const finalPart = await multipart.uploadPart(state.nextPartNumber, finalBytes);
          parts.push({
            partNumber: state.nextPartNumber,
            etag: finalPart.etag,
            bytes: finalBytes.byteLength,
          });
          await db
            .update(meetingUploads)
            .set({
              nextPartNumber: state.nextPartNumber + 1,
              etagsJson: JSON.stringify(parts),
              state: 'completing',
              updatedAt: Date.now(),
            })
            .where(eq(meetingUploads.meetingId, meeting.id));
          state = { ...state, nextPartNumber: state.nextPartNumber + 1, etagsJson: JSON.stringify(parts), state: 'completing' };
        }

        parts.sort((a, b) => a.partNumber - b.partNumber);
        if (state.state === 'completing') {
          const audioBucket = bucket();
          if (!(await audioBucket.head(key))) {
            const multipart = audioBucket.resumeMultipartUpload(key, state.uploadId);
            try {
              await multipart.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
            } catch (error) {
              if (!(await audioBucket.head(key))) throw error;
            }
          }
        }

        const duration = await db
          .select({
            durationMs: sql<number>`coalesce(max(${meetingSegments.offsetMs} + ${meetingSegments.durationMs}), 0)`,
          })
          .from(meetingSegments)
          .where(eq(meetingSegments.meetingId, meeting.id));
        const durationMs = duration[0]?.durationMs ?? 0;
        const totalBytes = parts.reduce((total, part) => total + part.bytes, 0);
        const now = Date.now();

        await db
          .update(meetingUploads)
          .set({
            nextPartNumber: state.nextPartNumber,
            etagsJson: JSON.stringify(parts),
            state: 'complete',
            updatedAt: now,
          })
          .where(eq(meetingUploads.meetingId, meeting.id));
        await db
          .update(meetings)
          .set({
            audioR2Key: key,
            audioBytes: totalBytes,
            audioDurationSec: Math.round(durationMs / 1_000),
            audioFormat: archiveFormatOf(meeting),
            endedAt: now,
            durationSec: Math.round(durationMs / 1_000),
            status: 'processing',
            updatedAt: now,
          })
          .where(eq(meetings.id, meeting.id));
        await enqueue({ kind: 'summarize', meetingId: meeting.id });

        return Response.json({ ok: true, status: 'processing', audioBytes: totalBytes });
      },
    },
  },
});
