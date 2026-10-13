import { createFileRoute } from '@tanstack/react-router';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { resolveIngestActor } from '@/server/device-auth';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';

const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

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

        let audio: Uint8Array;
        const contentType = request.headers.get('content-type') ?? '';

        try {
          if (contentType.includes('multipart/form-data')) {
            const form = await request.formData();
            const file = form.get('audio') as File | null;
            if (!file) {
              return Response.json({ error: 'missing audio' }, { status: 400 });
            }
            audio = new Uint8Array(await file.arrayBuffer());
          } else {
            audio = new Uint8Array(await request.arrayBuffer());
          }
        } catch {
          return Response.json({ error: 'invalid request body' }, { status: 400 });
        }

        if (audio.byteLength === 0) {
          return Response.json({ error: 'empty audio' }, { status: 400 });
        }
        if (audio.byteLength > MAX_AUDIO_BYTES) {
          return Response.json({ error: 'audio too large' }, { status: 413 });
        }

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
