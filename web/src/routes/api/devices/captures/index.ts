import { createFileRoute } from '@tanstack/react-router';
import { clampLimit } from '@/lib/http/clamp-limit';
import { headerText } from '@/lib/http/header-text';
import { readCappedBody } from '@/lib/http/cap-body';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as capturesRepo from '@/db/repo/captures';
import { resolveIngestActor } from '@/server/device-auth';
import { captureKey, deleteObject, putObject } from '@/server/r2';
import { guardUserQuota, refundUserQuota } from '@/server/rate-limit';
import { emitWebhookEvent, webhookEnv, webhookItem } from '@/server/webhooks';

const MAX_OFFSET = 100_000;

const IMAGE = { kind: 'image', captureMode: 'screenshot', maxBytes: 50 * 1024 * 1024, title: 'Screenshot' } as const;
// The Mac's own limit for a note.
const NOTE = { kind: 'note', captureMode: 'note', maxBytes: 1024 * 1024, title: 'Note' } as const;

const TYPES: Record<string, { ext: string } & (typeof IMAGE | typeof NOTE)> = {
  'image/png': { ext: 'png', ...IMAGE },
  'image/jpeg': { ext: 'jpg', ...IMAGE },
  'image/webp': { ext: 'webp', ...IMAGE },
  'image/gif': { ext: 'gif', ...IMAGE },
  'image/heic': { ext: 'heic', ...IMAGE },
  'text/markdown': { ext: 'md', ...NOTE },
};

const clientIdSchema = z.string().uuid();

// Screenshots, pasted images and notes from the Mac app, so the user's other Macs can
// show them in their history. Device-token auth, like /api/sessions.
export const Route = createFileRoute('/api/devices/captures/')({
  server: {
    handlers: {
      // Images and notes this device did not upload, newest first.
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
        const items = await capturesRepo.listForDevice(getDb(), {
          userId: actor.userId,
          exceptDeviceId: actor.deviceId,
          limit,
          offset,
        });
        return Response.json({ items });
      },

      // Raw image or note body. Idempotent on x-client-capture-id, so a retried upload
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
        // Own keys only: `constructor` or `__proto__` must not pass as a type.
        const type = Object.hasOwn(TYPES, contentType) ? TYPES[contentType] : undefined;
        if (!type) return Response.json({ error: `unsupported media type: ${contentType || 'unknown'}` }, { status: 415 });
        const bytes = Number(request.headers.get('content-length') ?? '');
        if (!Number.isFinite(bytes) || bytes <= 0) return Response.json({ error: 'empty or unsized upload' }, { status: 411 });
        if (bytes > type.maxBytes) {
          return Response.json({ error: `${type.kind} too large (${type.maxBytes / (1024 * 1024)} MB max)` }, { status: 413 });
        }
        if (!request.body) return Response.json({ error: 'empty upload' }, { status: 400 });

        const db = getDb();
        const existing = await capturesRepo.getByClientId(db, { userId: actor.userId, clientCaptureId: clientId.data });
        if (existing) return Response.json({ id: existing.id, idempotent: true });

        const chargedAt = Date.now();
        const overQuota = await guardUserQuota(actor.userId, 'capture-sync', chargedAt);
        if (overQuota) return overQuota;

        const title = headerText(request.headers.get('x-title')) || type.title;
        const capturedAt = Math.floor(Number(request.headers.get('x-captured-at')));
        const createdAt = Number.isFinite(capturedAt) && capturedAt > 0 && capturedAt <= Date.now() + 60_000 ? capturedAt : Date.now();

        // One id names both the row and its R2 object.
        const captureId = pid('cap');
        const r2Key = captureKey({ userId: actor.userId, captureId, ext: type.ext });
        // A note's text is kept on the row too, so search and MCP can read it without R2.
        let noteText: string | null = null;
        try {
          if (type.kind === 'note') {
            // Null when the body runs past content-length; shorter is caught below.
            const body = await readCappedBody(request.body, bytes);
            if (!body || body.byteLength !== bytes) throw new Error('note length does not match content-length');
            // Lossy on purpose, as the Mac reads notes: bad bytes become U+FFFD in the
            // searchable copy rather than stopping the note syncing. R2 keeps the original.
            noteText = new TextDecoder().decode(body);
            await putObject(r2Key, body, contentType);
          } else {
            const { readable, writable } = new FixedLengthStream(bytes);
            const piped = (request.body as unknown as ReadableStream).pipeTo(writable);
            await Promise.all([putObject(r2Key, readable as unknown as Parameters<typeof putObject>[1], contentType), piped]);
          }
        } catch {
          // The Mac retries an interrupted upload under a new id, so nothing
          // written here is wanted, and only a stored capture counts.
          await deleteObject(r2Key).catch((cause: unknown) => console.warn('[device-captures] orphan cleanup failed', r2Key, cause));
          await refundUserQuota(actor.userId, 'capture-sync', chargedAt);
          return Response.json({ error: 'upload interrupted' }, { status: 400 });
        }

        const created = (id: string) =>
          emitWebhookEvent(webhookEnv(), actor.userId, 'capture.created', webhookItem({ id, kind: type.kind, title, createdAt }));
        try {
          const id = await capturesRepo.create(db, {
            id: captureId,
            userId: actor.userId,
            kind: type.kind,
            captureMode: type.captureMode,
            source: 'desktop',
            title,
            r2Key,
            contentType,
            bytes,
            clientCaptureId: clientId.data,
            deviceId: actor.deviceId ?? null,
            createdAt,
            ...(noteText === null ? {} : { transcript: noteText, transcriptStatus: 'complete' as const }),
          });
          await created(id);
          return Response.json({ id }, { status: 201 });
        } catch (error) {
          // The error may have come after the row was written (a lost
          // reply): then this capture is stored, and stays.
          const winner = await capturesRepo.getByClientId(db, { userId: actor.userId, clientCaptureId: clientId.data });
          if (winner?.id === captureId) {
            await created(captureId);
            return Response.json({ id: captureId }, { status: 201 });
          }
          // No row points at this object, so don't leave it behind, and this
          // request stored nothing, so it doesn't count.
          await deleteObject(r2Key).catch((cause: unknown) => console.warn('[device-captures] orphan cleanup failed', r2Key, cause));
          await refundUserQuota(actor.userId, 'capture-sync', chargedAt);
          // Two uploads of the same capture raced: the other one won.
          if (winner) return Response.json({ id: winner.id, idempotent: true });
          throw error;
        }
      },
    },
  },
});
