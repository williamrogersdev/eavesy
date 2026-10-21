import * as dictionary from '@/db/repo/dictionary';
import { repairTranscript, repairAi } from '@/lib/ai/repair-transcript';
import type { CreditEnv } from '@/lib/ai/credit-runner';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as dictationsRepo from '@/db/repo/dictations';
import { transcriptionPrefs } from '@/db/repo/users';
import { applyTemplate } from '@/lib/ai/clean-dictation';
import { transcribeAudioFile } from '@/lib/transcription/transcribe-file';
import { meetingFolderSlug } from '@/lib/utils';
import { guardUserQuota } from '@/server/rate-limit';
import { resolveActor } from '@/server/auth';
import { dictationAudioKey, putAudio } from '@/server/r2';
import { enqueue } from '@/server/queue';

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
        const overQuota = await guardUserQuota(actor.userId, 'dictation');
        if (overQuota) return overQuota;

        const form = await request.formData().catch(() => null);
        const file = form?.get('audio');
        if (!form || !(file instanceof File)) return Response.json({ error: 'missing audio' }, { status: 400 });
        const targetApp = (form.get('targetApp') as string | null) ?? undefined;
        const templatePrompt = (form.get('templatePrompt') as string | null) ?? undefined;

        const db = getDb();
        const audio = new Uint8Array(await file.arrayBuffer());
        const prefs = await transcriptionPrefs(db, actor.userId);
        const entries = await dictionary.list(db, actor.userId);
        const transcription = await transcribeAudioFile({
          audio,
          language: prefs.language,
          vocabulary: [...entries.map(e => e.to), ...prefs.vocabulary],
          spoken: prefs.spoken,
          voiceNote: true,
        });

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
