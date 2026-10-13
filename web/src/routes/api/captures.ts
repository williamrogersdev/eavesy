import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { pid } from '@/db/ids';
import * as activityRepo from '@/db/repo/activity';
import * as capturesRepo from '@/db/repo/captures';
import * as usersRepo from '@/db/repo/users';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { extractVisualText, isSupportedImageType } from '@/lib/vision';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveActor } from '@/server/auth';
import { captureKey, mediaProxyUrl, putObject } from '@/server/r2';

const MAX_BYTES = 200 * 1024 * 1024;

const KIND_EXT: Record<string, { kind: 'image' | 'video'; ext: string }> = {
  'image/png': { kind: 'image', ext: 'png' },
  'image/jpeg': { kind: 'image', ext: 'jpg' },
  'image/webp': { kind: 'image', ext: 'webp' },
  'video/webm': { kind: 'video', ext: 'webm' },
  'video/mp4': { kind: 'video', ext: 'mp4' },
};

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
        const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') ?? '100'), 200);
        const rows = await capturesRepo.listSummariesForUser(getDb(), { userId: actor.userId, limit });
        const items = rows.map(({ r2Key, ...c }) => ({ ...c, url: mediaProxyUrl(r2Key) }));
        return Response.json({ items });
      },

      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const overQuota = await guardUserQuota(actor.userId, 'capture');
        if (overQuota) return overQuota;

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: 'invalid request body' }, { status: 400 });
        }

        const file = form.get('file') as File | null;
        if (!file) return Response.json({ error: 'missing file' }, { status: 400 });
        if (file.size === 0) return Response.json({ error: 'empty file' }, { status: 400 });
        if (file.size > MAX_BYTES) return Response.json({ error: 'file too large' }, { status: 413 });

        const rawType = (file.type || (form.get('contentType') as string) || '').split(';')[0].trim();
        const mapped = KIND_EXT[rawType];
        if (!mapped) {
          return Response.json({ error: `unsupported media type: ${rawType || 'unknown'}` }, { status: 415 });
        }

        const captureMode = (form.get('captureMode') as string | null) ?? '';
        if (!['screenshot', 'webcam', 'screen'].includes(captureMode)) {
          return Response.json({ error: 'invalid captureMode' }, { status: 400 });
        }

        const durationMs = Number(form.get('durationMs') ?? '0');
        const width = numOrNull(form.get('width'));
        const height = numOrNull(form.get('height'));
        const title =
          (form.get('title') as string | null)?.trim() || defaultTitle(captureMode, new Date());

        const captureId = pid('cap');
        const r2Key = captureKey({ userId: actor.userId, captureId, ext: mapped.ext });

        const audioFile = form.get('audioFile') as File | null;

        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await putObject(r2Key, bytes, rawType);

          let transcript: string | null = null;
          let transcriptStatus: capturesRepo.TranscriptStatus = 'none';
          let transcriptError: string | null = null;
          try {
            if (mapped.kind === 'image' && isSupportedImageType(rawType)) {
              const user = await usersRepo.getById(getDb(), actor.userId);
              const visual = await extractVisualText({ image: bytes, mediaType: rawType, user });
              transcript = visual.empty ? null : visual.text;
              transcriptStatus = visual.empty ? 'failed' : 'complete';
            } else if (audioFile && audioFile.size > 0) {
              const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
              const result = await transcribeAudioFile({ audio: audioBytes, language: 'en' });
              transcript = result.text?.trim() || null;
              transcriptStatus = transcript ? 'complete' : 'failed';
            }
            // No audio track on a video → leave as 'none'.
          } catch (err) {
            transcriptStatus = 'failed';
            transcriptError = err instanceof Error ? err.message : 'transcription failed';
            console.warn('[captures] transcription failed', err);
          }

          const id = await capturesRepo.create(getDb(), {
            userId: actor.userId,
            kind: mapped.kind,
            captureMode: captureMode as capturesRepo.CaptureMode,
            source: 'web',
            title,
            r2Key,
            contentType: rawType,
            bytes: bytes.byteLength,
            durationSec: durationMs > 0 ? Math.round(durationMs / 1000) : null,
            width,
            height,
            transcript,
            transcriptStatus,
            transcriptError,
          });

          await activityRepo.log(getDb(), {
            userId: actor.userId,
            eventType: 'capture.create',
            metadata: { kind: mapped.kind, captureMode },
          });

          return Response.json({ id });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : 'upload failed' },
            { status: 500 },
          );
        }
      },
    },
  },
});

function numOrNull(v: FormDataEntryValue | null): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function defaultTitle(mode: string, at: Date): string {
  const label = mode === 'screenshot' ? 'Screenshot' : mode === 'webcam' ? 'Video' : 'Screen recording';
  return `${label} — ${at.toLocaleString()}`;
}
