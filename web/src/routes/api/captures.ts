import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as activityRepo from '@/db/repo/activity';
import * as capturesRepo from '@/db/repo/captures';
import * as usersRepo from '@/db/repo/users';
import { MAX_CAPTURE_BYTES, MAX_CAPTURE_IMAGE_BYTES, type WebCaptureMode } from '@/lib/capture/limits';
import { readCappedBody } from '@/lib/http/cap-body';
import { clampLimit } from '@/lib/http/clamp-limit';
import { headerText } from '@/lib/http/header-text';
import { extractVisualText, isSupportedImageType } from '@/lib/vision';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveActor } from '@/server/auth';
import { captureKey, deleteObject, mediaProxyUrl, putObject } from '@/server/r2';
import { emitWebhookEvent, webhookEnv, webhookItem } from '@/server/webhooks';

const KIND_EXT: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/png': { kind: 'image', ext: 'png' },
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};

const MODES: readonly WebCaptureMode[] = ['screenshot', 'webcam', 'screen'];
const PAGE = 100;

export const Route = createFileRoute('/api/captures')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const search = new URL(request.url).searchParams;
        const limit = clampLimit(search.get('limit'), PAGE, 200);
        const beforeParam = Number(search.get('before'));
        const before = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : undefined;
        const rows = await capturesRepo.listSummariesForUser(getDb(), { userId: actor.userId, limit, before });
        const items = rows.map(({ r2Key, ...c }) => ({ ...c, url: mediaProxyUrl(r2Key) }));
        const nextBefore = rows.length === limit ? rows[rows.length - 1]?.createdAt ?? null : null;
        return Response.json({ items, nextBefore });
      },

      // Raw-body upload (not multipart): a video streams straight into R2
      // instead of being buffered in Worker memory. The capture's details
      // travel in headers; a video's separate audio track follows in
      // `POST /api/captures/$id/audio`.
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }

        const rawType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
        const mapped = KIND_EXT[rawType];
        if (!mapped) {
          return Response.json({ error: `unsupported media type: ${rawType || 'unknown'}` }, { status: 415 });
        }
        const captureMode = (request.headers.get('x-capture-mode') ?? '') as WebCaptureMode;
        if (!MODES.includes(captureMode)) {
          return Response.json({ error: 'invalid captureMode' }, { status: 400 });
        }
        const declared = Number(request.headers.get('content-length') ?? '');
        if (!Number.isFinite(declared) || declared <= 0) {
          return Response.json({ error: 'empty or unsized upload' }, { status: 411 });
        }
        const maxBytes = mapped.kind === 'image' ? MAX_CAPTURE_IMAGE_BYTES : MAX_CAPTURE_BYTES;
        if (declared > maxBytes) {
          return Response.json({ error: `file too large (${maxBytes / (1024 * 1024)} MB max)` }, { status: 413 });
        }
        if (!request.body) return Response.json({ error: 'empty upload' }, { status: 400 });

        // Only a request that will be stored counts toward the quota.
        const overQuota = await guardUserQuota(actor.userId, 'capture');
        if (overQuota) return overQuota;

        const durationMs = Number(request.headers.get('x-duration-ms') ?? '0');
        const width = positiveIntOrNull(request.headers.get('x-width'));
        const height = positiveIntOrNull(request.headers.get('x-height'));
        // The client names it in its own clock and locale; the Worker's would be UTC.
        const title = headerText(request.headers.get('x-title')) || defaultTitle(captureMode);

        const captureId = pid('cap');
        const r2Key = captureKey({ userId: actor.userId, captureId, ext: mapped.ext });

        let bytes: Uint8Array | null = null;
        let size = declared;
        try {
          if (mapped.kind === 'image') {
            // Images are read once: the same bytes go to R2 and to text extraction.
            bytes = await readCappedBody(request.body, MAX_CAPTURE_IMAGE_BYTES);
            if (!bytes) return Response.json({ error: `file too large (${MAX_CAPTURE_IMAGE_BYTES / (1024 * 1024)} MB max)` }, { status: 413 });
            if (bytes.byteLength === 0) return Response.json({ error: 'empty file' }, { status: 400 });
            size = bytes.byteLength;
            await putObject(r2Key, bytes, rawType);
          } else {
            const { readable, writable } = new FixedLengthStream(declared);
            const piped = (request.body as unknown as ReadableStream).pipeTo(writable);
            await Promise.all([putObject(r2Key, readable as unknown as Parameters<typeof putObject>[1], rawType), piped]);
          }
        } catch (err) {
          console.warn('[captures] upload interrupted', err);
          return Response.json({ error: 'upload interrupted' }, { status: 400 });
        }

        let transcript: string | null = null;
        let transcriptStatus: capturesRepo.TranscriptStatus = 'none';
        let transcriptError: string | null = null;
        if (bytes && isSupportedImageType(rawType)) {
          try {
            const user = actor.user ?? (await usersRepo.getById(getDb(), actor.userId));
            const visual = await extractVisualText({ image: bytes, mediaType: rawType, user });
            transcript = visual.empty ? null : visual.text;
            transcriptStatus = visual.empty ? 'failed' : 'complete';
          } catch (err) {
            transcriptStatus = 'failed';
            transcriptError = 'Could not read text from this image.';
            console.warn('[captures] text extraction failed', err);
          }
        }

        let id: string;
        try {
          id = await capturesRepo.create(getDb(), {
            id: captureId,
            userId: actor.userId,
            kind: mapped.kind,
            captureMode,
            source: 'web',
            title,
            r2Key,
            contentType: rawType,
            bytes: size,
            durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : null,
            width,
            height,
            transcript,
            transcriptStatus,
            transcriptError,
          });
        } catch (err) {
          console.error('[captures] insert failed', err);
          await deleteObject(r2Key).catch((cause: unknown) => console.warn('[captures] orphan cleanup failed', r2Key, cause));
          return Response.json({ error: 'upload failed' }, { status: 500 });
        }

        await activityRepo.log(getDb(), {
          userId: actor.userId,
          eventType: 'capture.create',
          metadata: { kind: mapped.kind, captureMode },
        });
        await emitWebhookEvent(webhookEnv(), actor.userId, 'capture.created', webhookItem({ id, kind: mapped.kind, title, createdAt: Date.now() }));

        return Response.json({ id });
      },
    },
  },
});

function positiveIntOrNull(v: string | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function defaultTitle(mode: WebCaptureMode): string {
  return mode === 'screenshot' ? 'Screenshot' : mode === 'webcam' ? 'Video' : 'Screen recording';
}
