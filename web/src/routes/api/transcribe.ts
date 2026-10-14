import { createFileRoute } from '@tanstack/react-router';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { resolveIngestActor } from '@/server/device-auth';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';

// One Whisper call takes the whole file as base64, so the request, the decoded
// audio, and the base64 copy all sit in a 128 MB isolate at once. The desktop
// app sends 4-minute 16 kHz WAV pieces (~8 MB), well under this cap.
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES;

const tooLarge = () => Response.json({ error: 'audio too large' }, { status: 413 });

/** Reads at most `limit` bytes, cancelling the upload as soon as it runs past. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function authorize(request: Request): Promise<Response | null> {
  let actor;
  try {
    actor = await resolveIngestActor(request);
  } catch {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return guardUserQuota(actor.userId, 'transcribe');
}

export const Route = createFileRoute('/api/transcribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const denied = await authorize(request);
        if (denied) return denied;

        const limited = await guardSpend(request, 'transcribe', { perMin: 20, perDay: 5000 });
        if (limited) return limited;

        if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();

        let audio: Uint8Array;
        const contentType = request.headers.get('content-type') ?? '';

        try {
          const body = await readCapped(request, MAX_BODY_BYTES);
          if (!body) return tooLarge();
          if (contentType.includes('multipart/form-data')) {
            const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
            const file = form.get('audio') as File | null;
            if (!file) {
              return Response.json({ error: 'missing audio' }, { status: 400 });
            }
            if (file.size > MAX_AUDIO_BYTES) return tooLarge();
            audio = new Uint8Array(await file.arrayBuffer());
          } else {
            audio = body;
          }
        } catch {
          return Response.json({ error: 'invalid request body' }, { status: 400 });
        }

        if (audio.byteLength === 0) {
          return Response.json({ error: 'empty audio' }, { status: 400 });
        }
        if (audio.byteLength > MAX_AUDIO_BYTES) return tooLarge();

        const url = new URL(request.url);
        const language = url.searchParams.get('language') ?? 'en';

        try {
          const result = await transcribeAudioFile({ audio, language });
          return Response.json({
            text: result.text,
            language: result.language ?? language,
            durationSec: result.durationSec ?? null,
          });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : 'transcription failed' },
            { status: 502 },
          );
        }
      },
    },
  },
});
