import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as dropsRepo from '@/db/repo/drops';
import { resolveActor } from '@/server/auth';
import { publish } from '@/server/drops-hub';
import { deviceLabelFrom, dropKey, MAX_FILE_BYTES, originFrom, safeFilename, toDto } from '@/server/drops';
import { putObject } from '@/server/r2';
import { guardUserQuota } from '@/server/rate-limit';

// Raw-body upload (not multipart) so the file streams straight into R2 instead
// of being buffered in Worker memory.
export const Route = createFileRoute('/api/drops/upload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const bytes = Number(request.headers.get('content-length') ?? '');
        if (!Number.isFinite(bytes) || bytes <= 0) {
          return Response.json({ error: 'empty or unsized upload' }, { status: 411 });
        }
        if (bytes > MAX_FILE_BYTES) return Response.json({ error: 'file too large (100 MB max)' }, { status: 413 });
        if (!request.body) return Response.json({ error: 'empty upload' }, { status: 400 });

        const overQuota = await guardUserQuota(actor.userId, 'drop');
        if (overQuota) return overQuota;

        let rawName: string | null = request.headers.get('x-filename');
        try {
          rawName = rawName ? decodeURIComponent(rawName) : null;
        } catch {
          // Leave it percent-encoded rather than reject the upload.
        }
        const filename = safeFilename(rawName);
        const contentType =
          (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() ||
          'application/octet-stream';

        const id = pid('drp');
        const r2Key = dropKey(actor.userId, id, filename);
        const { readable, writable } = new FixedLengthStream(bytes);
        const piped = (request.body as unknown as ReadableStream).pipeTo(writable);
        try {
          await Promise.all([
            putObject(r2Key, readable as unknown as Parameters<typeof putObject>[1], contentType),
            piped,
          ]);
        } catch {
          return Response.json({ error: 'upload interrupted' }, { status: 400 });
        }

        const row: dropsRepo.Drop = {
          id,
          userId: actor.userId,
          kind: 'file',
          text: null,
          preview: null,
          r2Key,
          filename,
          contentType,
          bytes,
          deviceLabel: deviceLabelFrom(request),
          createdAt: Date.now(),
        };
        await dropsRepo.create(getDb(), row);

        const drop = toDto(row);
        await publish(actor.userId, { type: 'drop', drop, origin: originFrom(request) });
        return Response.json({ drop }, { status: 201 });
      },
    },
  },
});
