import * as dictionary from '@/db/repo/dictionary';
import { repairTranscript, repairAi } from '@/lib/ai/repair-transcript';
import type { CreditEnv } from '@/lib/ai/credit-runner';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { transcriptionPrefs } from '@/db/repo/users';
import { isTranscriptionLanguage } from '@/lib/transcription/language';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { resolveIngestActor } from '@/server/device-auth';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';

// The desktop app still sends whole clips (clip.mp4, or the m4a fallback)
// unsplit, so uploads up to 100 MB have to keep working until it splits them.
// One Whisper call takes the whole file as base64, so this is close to what a
// 128 MB isolate can hold; the body is read once and nothing else is kept.
export const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + MULTIPART_OVERHEAD_BYTES;

const tooLarge = () => Response.json({ error: 'audio too large' }, { status: 413 });

/**
 * Passes `body` through until it runs past `limit` bytes, then errors, which
 * cancels the upload. `overflowed()` tells that error apart from a bad body.
 */
export function capBody(body: ReadableStream<Uint8Array>, limit: number) {
  let total = 0;
  let overflow = false;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > limit) {
          overflow = true;
          controller.error(new Error('body too large'));
        } else {
          controller.enqueue(chunk);
        }
      },
    }),
  );
  return { stream, overflowed: () => overflow };
}

async function readAudio(request: Request): Promise<Uint8Array | Response> {
  if (!request.body) return Response.json({ error: 'empty audio' }, { status: 400 });
  const contentType = request.headers.get('content-type') ?? '';
  const { stream, overflowed } = capBody(request.body, MAX_BODY_BYTES);
  try {
    if (!contentType.includes('multipart/form-data')) {
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // Parse straight from the (capped) request stream; only the form's file
    // and the copy taken from it exist at once, and the form is dropped here.
    const file = (await new Response(stream, { headers: { 'content-type': contentType } }).formData()).get('audio');
    if (!(file instanceof File)) return Response.json({ error: 'missing audio' }, { status: 400 });
    if (file.size > MAX_AUDIO_BYTES) return tooLarge();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return overflowed() ? tooLarge() : Response.json({ error: 'invalid request body' }, { status: 400 });
  }
}

export const Route = createFileRoute('/api/transcribe')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }

        // Size checks come before the quota and spend counters, so an upload
        // that is refused anyway doesn't use up the caller's (or everyone's) budget.
        if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
        const audio = await readAudio(request);
        if (audio instanceof Response) return audio;
        if (audio.byteLength === 0) return Response.json({ error: 'empty audio' }, { status: 400 });
        if (audio.byteLength > MAX_AUDIO_BYTES) return tooLarge();

        const overQuota = await guardUserQuota(actor.userId, 'transcribe');
        if (overQuota) return overQuota;
        const limited = await guardSpend(request, 'transcribe', { perMin: 20, perDay: 5000 });
        if (limited) return limited;

        const url = new URL(request.url);
        const prefs = await transcriptionPrefs(getDb(), actor.userId);
        const entries = await dictionary.list(getDb(), actor.userId);
        const requested = url.searchParams.get('language')?.trim().toLowerCase();
        const language = requested && isTranscriptionLanguage(requested) ? requested : prefs.language;
        // `voice=1` marks the user's own mic alone, such as a dictation.
        const voiceNote = url.searchParams.get('voice') === '1';

        try {
          const result = await transcribeAudioFile({
            audio,
            language,
            vocabulary: [...entries.map(e => e.to), ...prefs.vocabulary],
            spoken: prefs.spoken,
            voiceNote,
          });
          const repaired = await repairTranscript(result.text, { dictionary: entries, clean: voiceNote, ai: repairAi(getCloudflareContext<CreditEnv>().env) });
          return Response.json({
            text: repaired.text,
            rawText: result.text,
            repairStatus: repaired.status,
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
