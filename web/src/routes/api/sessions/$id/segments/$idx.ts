import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import { meetingSegments, meetings } from '@/db/schema';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveIngestActor } from '@/server/device-auth';
import { enqueue } from '@/server/queue';
import { meetingSegmentKey, putAudio } from '@/server/r2';
import { boundedInteger, MAX_SEGMENT_BYTES, ownedMeeting } from '@/server/session-ingest';

const SEGMENT_TRACKS = ['mixed', 'mic', 'system'] as const;

export const Route = createFileRoute('/api/sessions/$id/segments/$idx')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const idx = boundedInteger(params.idx, { min: 0, max: 100_000 });
        const durationMs = boundedInteger(request.headers.get('x-segment-duration-ms'), {
          min: 1,
          max: 10 * 60 * 1_000,
        });
        const startMs = boundedInteger(request.headers.get('x-segment-start-ms'), {
          min: 0,
          max: 72 * 60 * 60 * 1_000,
        });
        const trackHeader = request.headers.get('x-segment-track') ?? 'mixed';
        const track = SEGMENT_TRACKS.find((candidate) => candidate === trackHeader);
        const activeHeader = request.headers.get('x-segment-active-ms');
        const activeMs =
          activeHeader === null ? null : boundedInteger(activeHeader, { min: 0, max: 10 * 60 * 1_000 });
        const badActiveMs = activeHeader !== null && activeMs === null;
        if (idx === null || durationMs === null || startMs === null || !track || badActiveMs) {
          return Response.json({ error: 'invalid_segment_metadata' }, { status: 400 });
        }

        const contentLength = Number(request.headers.get('content-length') ?? '0');
        if (contentLength > MAX_SEGMENT_BYTES) {
          return Response.json({ error: 'segment_too_large' }, { status: 413 });
        }

        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });
        if (meeting.audioR2Key || meeting.status === 'failed') {
          return Response.json({ error: 'session_not_recording' }, { status: 409 });
        }

        const existing = (
          await db
            .select()
            .from(meetingSegments)
            .where(
              and(
                eq(meetingSegments.meetingId, meeting.id),
                eq(meetingSegments.idx, idx),
                eq(meetingSegments.track, track),
              ),
            )
            .limit(1)
        )[0];
        if (existing) {
          if (existing.transcribeStatus !== 'complete') {
            await enqueue({ kind: 'transcribe-segment', meetingId: meeting.id, idx, track });
          }
          return Response.json({ ok: true, idempotent: true, nextSegmentIdx: idx + 1 });
        }

        const overQuota = await guardUserQuota(actor.userId, 'segment');
        if (overQuota) return overQuota;

        const audio = new Uint8Array(await request.arrayBuffer());
        if (audio.byteLength === 0) return Response.json({ error: 'empty_segment' }, { status: 400 });
        if (audio.byteLength > MAX_SEGMENT_BYTES) {
          return Response.json({ error: 'segment_too_large' }, { status: 413 });
        }

        const r2Key = meetingSegmentKey(actor.userId, meeting.id, idx, track);
        await putAudio(r2Key, audio, request.headers.get('content-type') ?? 'audio/mp4');

        // A concurrent retry of the same segment may have won the race between the
        // lookup above and here; the unique (meeting, idx, track) index decides.
        const inserted = await db.insert(meetingSegments).values({
          id: pid('mseg'),
          meetingId: meeting.id,
          idx,
          track,
          activeMs,
          r2Key,
          bytes: audio.byteLength,
          offsetMs: startMs,
          durationMs,
          transcribeStatus: 'pending',
          createdAt: Date.now(),
        }).onConflictDoNothing().returning({ id: meetingSegments.id });
        if (inserted.length === 0) {
          return Response.json({ ok: true, idempotent: true, nextSegmentIdx: idx + 1 });
        }
        await db
          .update(meetings)
          .set({ status: 'uploading', updatedAt: Date.now() })
          .where(eq(meetings.id, meeting.id));
        await enqueue({ kind: 'transcribe-segment', meetingId: meeting.id, idx, track });

        return Response.json({ ok: true, nextSegmentIdx: idx + 1 }, { status: 202 });
      },
    },
  },
});
