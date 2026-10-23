import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as capturesRepo from '@/db/repo/captures';
import * as usersRepo from '@/db/repo/users';
import { MAX_CAPTURE_AUDIO_BYTES } from '@/lib/capture/limits';
import { readCappedBody } from '@/lib/http/cap-body';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { resolveActor } from '@/server/auth';

const tooLarge = () =>
  Response.json({ error: `audio too large (${MAX_CAPTURE_AUDIO_BYTES / (1024 * 1024)} MB max)` }, { status: 413 });

// The audio track of a web video capture, sent as a raw body right after the
// video itself (`POST /api/captures`), and transcribed into the capture. Each
// capture is transcribed at most once: the status moves none → processing
// before any work starts, and a second call gets 409.
export const Route = createFileRoute('/api/captures/$id/audio')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const declared = Number(request.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_CAPTURE_AUDIO_BYTES) return tooLarge();
        if (!request.body) return Response.json({ error: 'empty audio' }, { status: 400 });

        const db = getDb();
        const capture = await capturesRepo.get(db, { captureId: params.id, userId: actor.userId });
        if (!capture) return Response.json({ error: 'not found' }, { status: 404 });
        if (capture.kind !== 'video') return Response.json({ error: 'not a video capture' }, { status: 409 });

        const audio = await readCappedBody(request.body, MAX_CAPTURE_AUDIO_BYTES).catch(() => undefined);
        if (audio === undefined) return Response.json({ error: 'upload interrupted' }, { status: 400 });
        if (audio === null) return tooLarge();
        if (audio.byteLength === 0) return Response.json({ error: 'empty audio' }, { status: 400 });

        const claimed = await capturesRepo.claimTranscript(db, {
          captureId: capture.id,
          userId: actor.userId,
          from: 'none',
          to: 'processing',
        });
        if (!claimed) return Response.json({ error: 'already transcribed' }, { status: 409 });

        try {
          const { language, vocabulary, spoken } = await usersRepo.transcriptionPrefs(db, actor.userId);
          const result = await transcribeAudioFile({ audio, language, vocabulary, spoken });
          const transcript = result.text?.trim() || null;
          await capturesRepo.setTranscript(db, {
            captureId: capture.id,
            userId: actor.userId,
            status: transcript ? 'complete' : 'failed',
            transcript,
          });
          return Response.json({ ok: true, transcriptStatus: transcript ? 'complete' : 'failed' });
        } catch (err) {
          console.warn('[captures] audio transcription failed', err);
          await capturesRepo.setTranscript(db, {
            captureId: capture.id,
            userId: actor.userId,
            status: 'failed',
            error: 'Could not transcribe this recording.',
          });
          return Response.json({ error: 'transcription failed' }, { status: 502 });
        }
      },
    },
  },
});
