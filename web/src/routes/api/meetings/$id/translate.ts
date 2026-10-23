import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as meetingsRepo from '@/db/repo/meetings';
import * as translationsRepo from '@/db/repo/translations';
import * as usersRepo from '@/db/repo/users';
import { translateLines } from '@/lib/ai/translate';
import { resolveModelPlan } from '@/lib/providers/router';
import { isNotesLanguage } from '@/lib/transcription/language';
import { resolveActor } from '@/server/auth';
import { guardUserQuota } from '@/server/rate-limit';

/** Lines translated per request, four model batches; the client asks again for the rest. */
export const LINES_PER_REQUEST = 240;

const schema = z.object({
  to: z.string().trim().toLowerCase().refine(isNotesLanguage, 'unsupported language'),
});

export const Route = createFileRoute('/api/meetings/$id/translate')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const to = parsed.data.to;

        const db = getDb();
        const meeting = await meetingsRepo.get(db, { meetingId: params.id, userId: actor.userId });
        if (!meeting) return Response.json({ error: 'not_found' }, { status: 404 });

        const { lines, translated } = await translationsRepo.linesWithTranslations(db, {
          meetingId: meeting.id,
          language: to,
        });
        const untranslated = lines.filter(
          (line) => line.language !== to && !translated.has(line.id),
        );
        const missing = untranslated.slice(0, LINES_PER_REQUEST);

        if (missing.length > 0) {
          const overQuota = await guardUserQuota(actor.userId, 'translate');
          if (overQuota) return overQuota;
          const plan = resolveModelPlan(await usersRepo.getById(db, actor.userId));
          let fresh: Map<string, string>;
          try {
            fresh = await translateLines({
              lines: missing,
              to,
              openRouter: plan.openRouter,
              byoApiKey: plan.summary.apiKey,
            });
          } catch (error) {
            console.error('[meeting-translate] failed', error);
            return Response.json({ error: 'translation_failed' }, { status: 502 });
          }
          const source = new Map(missing.map((line) => [line.id, line.text]));
          const entries = [...fresh].flatMap(([segmentId, text]) => {
            const sourceText = source.get(segmentId);
            return sourceText === undefined ? [] : [{ segmentId, sourceText, text }];
          });
          await translationsRepo.saveTranslations(db, { meetingId: meeting.id, language: to, entries });
          for (const entry of entries) translated.set(entry.segmentId, entry.text);
        }

        return Response.json({
          language: to,
          lines: Object.fromEntries(translated),
          remaining: untranslated.length - missing.length,
        });
      },
    },
  },
});
