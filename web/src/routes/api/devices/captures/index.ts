import { createFileRoute } from '@tanstack/react-router';
import { clampLimit } from '@/lib/http/clamp-limit';
import { headerText } from '@/lib/http/header-text';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as capturesRepo from '@/db/repo/captures';
import { resolveIngestActor } from '@/server/device-auth';
import { captureKey, deleteObject, putObject } from '@/server/r2';
import { guardUserQuota } from '@/server/rate-limit';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_OFFSET = 100_000;

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
};

const clientIdSchema = z.string().uuid();

// Screenshots and pasted images from the Mac app, so the user's other Macs can
// show them in their history. Device-token auth, like /api/sessions.
export const Route = createFileRoute('/api/devices/captures/')({
  server: {
    handlers: {
      // Images this device did not upload, newest first.
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const search = new URL(request.url).searchParams;
        const limit = clampLimit(search.get('limit'), 50, 200);
        const offset = Math.max(Math.floor(Number(search.get('offset')) || 0), 0);
        if (offset > MAX_OFFSET) return Response.json({ items: [] });
        const items = await capturesRepo.listImagesForDevice(getDb(), {
          userId: actor.userId,
          exceptDeviceId: actor.deviceId,
          limit,
          offset,
        });
        return Response.json({ items });
      },

      // Raw image body. Idempotent on x-client-capture-id, so a retried upload
      // (or one whose response was lost) never makes a second copy.
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const clientId = clientIdSchema.safeParse(request.headers.get('x-client-capture-id'));
        if (!clientId.success) return Response.json({ error: 'invalid x-client-capture-id' }, { status: 400 });
        const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const ext = IMAGE_EXT[contentType];
        if (!ext) return Response.json({ error: `unsupported media type: ${contentType || 'unknown'}` }, { status: 415 });
        const bytes = Number(request.headers.get('content-length') ?? '');
        if (!Number.isFinite(bytes) || bytes <= 0) return Response.json({ error: 'empty or unsized upload' }, { status: 411 });
        if (bytes > MAX_BYTES) return Response.json({ error: 'image too large (50 MB max)' }, { status: 413 });
        if (!request.body) return Response.json({ error: 'empty upload' }, { status: 400 });

        const db = getDb();
        const existing = await capturesRepo.getByClientId(db, { userId: actor.userId, clientCaptureId: clientId.data });
        if (existing) return Response.json({ id: existing.id, idempotent: true });

        const overQuota = await guardUserQuota(actor.userId, 'capture-sync');
        if (overQuota) return overQuota;

        const title = headerText(request.headers.get('x-title')) || 'Screenshot';
        const capturedAt = Math.floor(Number(request.headers.get('x-captured-at')));
        const createdAt = Number.isFinite(capturedAt) && capturedAt > 0 && capturedAt <= Date.now() + 60_000 ? capturedAt : Date.now();

        // One id names both the row and its R2 object.
        const captureId = pid('cap');
        const r2Key = captureKey({ userId: actor.userId, captureId, ext });
        const { readable, writable } = new FixedLengthStream(bytes);
        const piped = (request.body as unknown as ReadableStream).pipeTo(writable);
        try {
          await Promise.all([putObject(r2Key, readable as unknown as Parameters<typeof putObject>[1], contentType), piped]);
        } catch {
          return Response.json({ error: 'upload interrupted' }, { status: 400 });
        }

        try {
          const id = await capturesRepo.create(db, {
            id: captureId,
            userId: actor.userId,
            kind: 'image',
            captureMode: 'screenshot',
            source: 'desktop',
            title,
            r2Key,
            contentType,
            bytes,
            clientCaptureId: clientId.data,
            deviceId: actor.deviceId ?? null,
            createdAt,
          });
          return Response.json({ id }, { status: 201 });
        } catch (error) {
          // No row points at this object now, so don't leave it behind.
          await deleteObject(r2Key).catch((cause: unknown) => console.warn('[device-captures] orphan cleanup failed', r2Key, cause));
          // Two uploads of the same capture raced: the other one won.
          const winner = await capturesRepo.getByClientId(db, { userId: actor.userId, clientCaptureId: clientId.data });
          if (winner) return Response.json({ id: winner.id, idempotent: true });
          throw error;
        }
      },
    },
  },
});
