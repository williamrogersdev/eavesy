import { createFileRoute } from '@tanstack/react-router';
import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import { meetingAttachments } from '@/db/schema';
import { imageSize, sniffImageType } from '@/lib/images/image-size';
import { resolveIngestActor } from '@/server/device-auth';
import { guardUserQuota } from '@/server/rate-limit';
import { meetingAttachmentKey, putObject } from '@/server/r2';
import { boundedInteger, ownedMeeting } from '@/server/session-ingest';

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const KINDS = ['snapshot', 'screenshot'] as const;
/** `snapshot-000123456`, `screenshot-000123456-2`: the Mac's file name without its extension. */
const NAME = /^(snapshot|screenshot)-\d{1,12}(-\d{1,4})?$/;

/**
 * A Snapshot of a shared screen, or a screenshot, taken during a meeting the
 * Mac is recording. Idempotent by name: a retry stores nothing new.
 * Headers: `x-attachment-kind`, `x-attachment-offset-ms` (from the start of the recording).
 */
export const Route = createFileRoute('/api/sessions/$id/attachments/$name')({
  server: {
    handlers: {
      PUT: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const kind = KINDS.find((candidate) => candidate === request.headers.get('x-attachment-kind'));
        const offsetMs = boundedInteger(request.headers.get('x-attachment-offset-ms'), {
          min: 0,
          max: 72 * 60 * 60 * 1_000,
        });
        if (!kind || offsetMs === null || !NAME.test(params.name) || !params.name.startsWith(kind)) {
          return Response.json({ error: 'invalid_attachment_metadata' }, { status: 400 });
        }
        if (Number(request.headers.get('content-length') ?? '0') > MAX_ATTACHMENT_BYTES) {
          return Response.json({ error: 'attachment_too_large' }, { status: 413 });
        }

        const db = getDb();
        const meeting = await ownedMeeting(db, params.id, actor);
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        const existing = await db
          .select({ id: meetingAttachments.id })
          .from(meetingAttachments)
          .where(and(eq(meetingAttachments.meetingId, meeting.id), eq(meetingAttachments.clientName, params.name)))
          .limit(1);
        if (existing[0]) return Response.json({ ok: true, idempotent: true, id: existing[0].id });

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength === 0) return Response.json({ error: 'empty_attachment' }, { status: 400 });
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return Response.json({ error: 'attachment_too_large' }, { status: 413 });
        }
        // The stored type is what the bytes are, never what the upload says.
        const contentType = sniffImageType(bytes);
        if (!contentType) return Response.json({ error: 'unsupported_image' }, { status: 415 });

        const overQuota = await guardUserQuota(actor.userId, 'meeting-attachment');
        if (overQuota) return overQuota;

        const r2Key = meetingAttachmentKey(actor.userId, meeting.id, params.name, contentType);
        await putObject(r2Key, bytes, contentType);
        const size = imageSize(bytes);
        const id = pid('matt');
        const inserted = await db
          .insert(meetingAttachments)
          .values({
            id,
            meetingId: meeting.id,
            userId: actor.userId,
            kind,
            clientName: params.name,
            offsetMs,
            r2Key,
            contentType,
            bytes: bytes.byteLength,
            width: size?.width ?? null,
            height: size?.height ?? null,
            createdAt: Date.now(),
          })
          // A concurrent retry may have won; the unique (meeting, name) index decides.
          .onConflictDoNothing()
          .returning({ id: meetingAttachments.id });
        if (inserted.length === 0) return Response.json({ ok: true, idempotent: true });
        return Response.json({ ok: true, id }, { status: 201 });
      },
    },
  },
});
