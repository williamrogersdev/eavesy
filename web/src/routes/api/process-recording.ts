import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { meetingFolderSlug } from '@/lib/utils';
import { resolveActor } from '@/server/auth';
import { enqueue } from '@/server/queue';
import { meetingAudioKey, putAudio } from '@/server/r2';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export const Route = createFileRoute('/api/process-recording')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'must be signed in' }, { status: 401 });
        }

        const limited = await guardSpend(request, 'process', { perMin: 10, perDay: 2000 })
          ?? await guardUserQuota(actor.userId, 'process');
        if (limited) return limited;

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return Response.json({ error: 'invalid request body' }, { status: 400 });
        }
        const file = form.get('audio');
        if (!(file instanceof File)) {
          return Response.json({ error: 'missing audio' }, { status: 400 });
        }
        if (file.size === 0) return Response.json({ error: 'empty audio' }, { status: 400 });
        if (file.size > MAX_AUDIO_BYTES) {
          return Response.json({ error: 'audio too large' }, { status: 413 });
        }

        const rawDurationMs = Number(form.get('durationMs') ?? '0');
        const durationMs = Number.isFinite(rawDurationMs) ? Math.max(0, rawDurationMs) : 0;
        const requestedSource = (form.get('source') as string | null) ?? 'web';
        const source: meetingsRepo.MeetingSource = requestedSource === 'import' ? 'import' : 'web';
        const db = getDb();
        const meetingId = await meetingsRepo.start(db, {
          userId: actor.userId,
          source,
          title: 'Recording — processing…',
          isAnonymous: actor.isAnonymous,
          localFolderSlug: meetingFolderSlug('Recording', new Date()),
        });
        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.start',
          meetingId,
          metadata: { source },
        });

        let audioSaved = false;
        try {
          const audioBytes = new Uint8Array(await file.arrayBuffer());
          const mimeType = (file.type || 'audio/webm').split(';')[0].trim();
          const audioFormat = formatForMime(mimeType);
          const audioR2Key = meetingAudioKey({
            isAnonymous: actor.isAnonymous,
            userId: actor.userId,
            meetingId,
            format: audioFormat,
          });
          await putAudio(audioR2Key, audioBytes, mimeType);
          audioSaved = true;
          await meetingsRepo.finalize(db, {
            meetingId,
            userId: actor.userId,
            endedAt: Date.now(),
            durationSec: Math.round(durationMs / 1000),
            audioR2Key,
            audioBytes: audioBytes.byteLength,
            audioFormat,
          });
          await meetingsRepo.update(db, {
            meetingId,
            userId: actor.userId,
            status: 'processing',
            statusError: null,
          });
          await activityRepo.log(db, {
            userId: actor.userId,
            eventType: 'meeting.finalize',
            meetingId,
          });
        } catch (error) {
          console.error('[process-recording] ingest failed', error);
          const statusError = audioSaved
            ? 'The recording was saved, but its upload could not be finalized.'
            : 'The recording upload could not be completed.';
          await meetingsRepo.update(db, {
            meetingId,
            userId: actor.userId,
            status: 'failed',
            statusError,
          });
          await activityRepo.log(db, {
            userId: actor.userId,
            eventType: 'meeting.fail',
            meetingId,
            metadata: { reason: audioSaved ? 'finalize_failed' : 'upload_failed' },
          });
          return Response.json({ error: statusError, meetingId }, { status: 500 });
        }

        try {
          await enqueue({ kind: 'process-recording', meetingId });
        } catch (error) {
          console.error('[process-recording] initial queue handoff delayed', error);
          await meetingsRepo.update(db, {
            meetingId,
            userId: actor.userId,
            status: 'processing',
            statusError: 'Processing was delayed and will retry automatically.',
          });
          return Response.json({ meetingId, status: 'processing', delayed: true }, { status: 202 });
        }

        return Response.json({ meetingId, status: 'processing' }, { status: 202 });
      },
    },
  },
});

function formatForMime(mimeType: string): 'm4a' | 'webm' | 'mp3' | 'opus' | 'wav' {
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return 'm4a';
  if (mimeType.includes('opus') || mimeType.includes('ogg')) return 'opus';
  return 'webm';
}
