import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as capturesRepo from '@/db/repo/captures';
import * as usersRepo from '@/db/repo/users';
import { MAX_CAPTURE_AUDIO_BYTES } from '@/lib/capture/limits';
import { readCappedBody } from '@/lib/http/cap-body';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { resolveActor } from '@/server/auth';

const MAX_AUDIO_MB = MAX_CAPTURE_AUDIO_BYTES / (1024 * 1024);

// The audio track of a web video capture, sent as a raw body right after the
// video itself (`POST /api/captures`), and transcribed into the capture. Each
// capture is transcribed at most once: the status moves none → processing
// before any work starts, and a second call gets 409. A claim left
// `processing` by a request that was cut off can be taken again after
// `TRANSCRIPT_CLAIM_TTL_MS`, so a capture never waits on a transcript forever.
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
        if (!request.body) return Response.json({ error: 'empty audio' }, { status: 400 });

        const db = getDb();
        const capture = await capturesRepo.get(db, { captureId: params.id, userId: actor.userId });
        if (!capture) return Response.json({ error: 'not found' }, { status: 404 });
        if (capture.kind !== 'video') return Response.json({ error: 'not a video capture' }, { status: 409 });

        // The capture bar doesn't wait on this answer: the capture's own page
        // has to say why there is no transcript, so a track too large to
        // transcribe fails the transcript instead of leaving it missing.
        const tooLarge = async () => {
          try {
            await capturesRepo.claimTranscript(db, {
              captureId: capture.id,
              userId: actor.userId,
              from: 'none',
              to: 'failed',
              error: `The audio track is too large to transcribe (${MAX_AUDIO_MB} MB max).`,
            });
          } catch (err) {
            // The answer is still the size; the page just can't say why yet.
            console.warn('[captures] could not record the too-large audio track', err);
          }
          return Response.json({ error: `audio too large (${MAX_AUDIO_MB} MB max)` }, { status: 413 });
        };
        const declared = Number(request.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > MAX_CAPTURE_AUDIO_BYTES) return tooLarge();

        const audio = await readCappedBody(request.body, MAX_CAPTURE_AUDIO_BYTES).catch(() => undefined);
        if (audio === undefined) return Response.json({ error: 'upload interrupted' }, { status: 400 });
        if (audio === null) return tooLarge();
        if (audio.byteLength === 0) return Response.json({ error: 'empty audio' }, { status: 400 });

        const claimed = await capturesRepo.claimTranscript(db, {
          captureId: capture.id,
          userId: actor.userId,
          from: 'none',
          to: 'processing',
          staleAfterMs: capturesRepo.TRANSCRIPT_CLAIM_TTL_MS,
        });
        if (!claimed) return Response.json({ error: 'already transcribed' }, { status: 409 });

        try {
          const { language, vocabulary, spoken } = await usersRepo.transcriptionPrefs(db, actor.userId);
          const result = await transcribeAudioFile({ audio, language, vocabulary, spoken });
          const transcript = result.text?.trim() || null;
          // Only while this request still holds the claim: a result that
          // outlived its claim and lost to a second upload is dropped.
          await capturesRepo.setTranscript(db, {
            captureId: capture.id,
            userId: actor.userId,
            status: transcript ? 'complete' : 'failed',
            transcript,
            ifStatus: 'processing',
          });
          return Response.json({ ok: true, transcriptStatus: transcript ? 'complete' : 'failed' });
        } catch (err) {
          console.warn('[captures] audio transcription failed', err);
          await capturesRepo.setTranscript(db, {
            captureId: capture.id,
            userId: actor.userId,
            status: 'failed',
            error: 'Could not transcribe this recording.',
            ifStatus: 'processing',
          });
          return Response.json({ error: 'transcription failed' }, { status: 502 });
        }
      },
    },
  },
});
