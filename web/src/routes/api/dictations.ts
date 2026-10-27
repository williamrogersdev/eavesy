import * as dictionary from '@/db/repo/dictionary';
import { repairTranscript, repairAi } from '@/lib/ai/repair-transcript';
import type { CreditEnv } from '@/lib/ai/credit-runner';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as dictationsRepo from '@/db/repo/dictations';
import { transcriptionPrefs } from '@/db/repo/users';
import { applyTemplate } from '@/lib/ai/clean-dictation';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { meetingFolderSlug } from '@/lib/utils';
import { guardSpend, guardUserQuota } from '@/server/rate-limit';
import { capBody } from '@/lib/http/cap-body';
import { resolveActor } from '@/server/auth';
import { dictationAudioKey, putAudio } from '@/server/r2';
import { enqueue } from '@/server/queue';

// A dictation is a short voice note; the web recorder's clips are well under this.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_BODY_BYTES = MAX_AUDIO_BYTES + 64 * 1024;
const tooLarge = () => Response.json({ error: 'audio too large' }, { status: 413 });

const fieldsSchema = z.object({
  targetApp: z.string().trim().max(200).optional(),
  templatePrompt: z.string().max(8000).optional(),
});

export const Route = createFileRoute('/api/dictations')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        // Size and shape first, so a request that is refused anyway spends no quota.
        if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();
        if (!request.body) return Response.json({ error: 'missing audio' }, { status: 400 });
        const { stream, overflowed } = capBody(request.body, MAX_BODY_BYTES);
        let form: FormData;
        try {
          form = await new Response(stream, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData();
        } catch {
          return overflowed() ? tooLarge() : Response.json({ error: 'invalid request body' }, { status: 400 });
        }
        const file = form.get('audio');
        if (!(file instanceof File) || file.size === 0) return Response.json({ error: 'missing audio' }, { status: 400 });
        if (file.size > MAX_AUDIO_BYTES) return tooLarge();
        const fields = fieldsSchema.safeParse({
          targetApp: form.get('targetApp') ?? undefined,
          templatePrompt: form.get('templatePrompt') ?? undefined,
        });
        if (!fields.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const { targetApp, templatePrompt } = fields.data;

        const overQuota = await guardUserQuota(actor.userId, 'dictation');
        if (overQuota) return overQuota;
        const limited = await guardSpend(request, 'transcribe', { perMin: 20, perDay: 5000 });
        if (limited) return limited;

        const db = getDb();
        const audio = new Uint8Array(await file.arrayBuffer());
        const prefs = await transcriptionPrefs(db, actor.userId);
        const entries = await dictionary.listForTranscription(db, actor.userId);
        let transcription;
        try {
          transcription = await transcribeAudioFile({
            audio,
            language: prefs.language,
            vocabulary: [...entries.map(e => e.to), ...prefs.vocabulary],
            spoken: prefs.spoken,
            voiceNote: true,
          });
        } catch (err) {
          console.error('[dictation] transcription failed', err);
          return Response.json({ error: 'transcription failed' }, { status: 502 });
        }

        let cleaned: string | undefined;
        try {
          if (templatePrompt) cleaned = await applyTemplate(transcription.text, templatePrompt);
          else {
            cleaned = (await repairTranscript(transcription.text, { clean: true, dictionary: entries, ai: repairAi(getCloudflareContext<CreditEnv>().env) })).text;
          }
        } catch (err) {
          console.warn('[dictation] cleanup failed', err);
        }

        const id = await dictationsRepo.create(db, {
          userId: actor.userId,
          title: deriveTitle(cleaned ?? transcription.text),
          transcript: transcription.text,
          cleanedText: cleaned,
          targetApp,
          durationSec: transcription.durationSec ?? 0,
          localFolderSlug: meetingFolderSlug('Dictation', new Date()),
        });

        const r2Key = dictationAudioKey({
          isAnonymous: actor.isAnonymous,
          userId: actor.userId,
          dictationId: id,
          format: 'webm',
        });
        try {
          await putAudio(r2Key, audio, file.type || 'audio/webm');
        } catch (err) {
          console.warn('[dictation] r2 put failed', err);
        }

        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'dictation.create',
          dictationId: id,
        });
        await enqueue({ kind: 'embed-dictation', dictationId: id });

        return Response.json({
          id,
          transcript: transcription.text,
          cleaned,
        });
      },

      GET: async () => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const items = await dictationsRepo.listForUser(getDb(), { userId: actor.userId });
        return Response.json({ items });
      },
    },
  },
});

function deriveTitle(text: string): string {
  const trimmed = text.trim().split(/\s+/).slice(0, 10).join(' ');
  return trimmed.length > 50 ? trimmed.slice(0, 50) + '…' : trimmed || 'Dictation';
}
