import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { polishDictation } from '@/lib/ai/agent-transcript';
import { anthropicOrNull } from '@/lib/ai/client';
import { combinedContext } from '@/lib/projects';
import { resolveModelPlan } from '@/lib/providers/router';
import { parseVocabulary } from '@/lib/transcription/vocabulary';
import { resolveIngestActor } from '@/server/device-auth';
import { guardUserQuota } from '@/server/rate-limit';

/** About twenty minutes of speech; the Mac app types anything longer as heard. */
export const MAX_POLISH_CHARS = 20_000;

const schema = z.object({ text: z.string().max(MAX_POLISH_CHARS) });

/**
 * Tidies a dictation's words before the Mac app types them: the recognizer's
 * text in, the text as the user would have typed it out.
 */
export const Route = createFileRoute('/api/dictations/polish')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const overQuota = await guardUserQuota(actor.userId, 'dictation');
        if (overQuota) return overQuota;
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });

        const user = actor.isAnonymous ? null : await usersRepo.getById(getDb(), actor.userId);
        const result = await polishDictation(anthropicOrNull(resolveModelPlan(user).summary.apiKey), {
          text: parsed.data.text,
          context: combinedContext(null, null, parseVocabulary(user?.customVocabularyJson)),
        });
        return Response.json(result);
      },
    },
  },
});
