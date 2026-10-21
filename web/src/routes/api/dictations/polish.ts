import * as dictionary from '@/db/repo/dictionary';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as usersRepo from '@/db/repo/users';
import { polishDictation } from '@/lib/ai/agent-transcript';
import { anthropic, anthropicForUser } from '@/lib/ai/client';
import { combinedContext } from '@/lib/projects';
import { resolveModelPlan } from '@/lib/providers/router';
import * as projectsRepo from '@/db/repo/projects';
import { effectiveDictation } from '@/lib/transcription/dictation-style';
import { stripFillers } from '@/lib/transcription/agent-transcript';
import { parseVocabulary } from '@/lib/transcription/vocabulary';
import { resolveIngestActor } from '@/server/device-auth';
import { guardUserQuota } from '@/server/rate-limit';

/** About twenty minutes of speech; anything longer gets only the model-free cleanup. */
export const MAX_POLISH_CHARS = 20_000;

const schema = z.object({ text: z.string().max(200_000), projectId: z.string().max(64).optional() });

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
        const parsed = schema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const text = parsed.data.text.trim();
        if (!text || text.length > MAX_POLISH_CHARS) {
          return Response.json({ text: stripFillers(text), polished: false });
        }

        const overQuota = await guardUserQuota(actor.userId, 'dictation');
        if (overQuota) return overQuota;

        const user = actor.isAnonymous ? null : await usersRepo.getById(getDb(), actor.userId);
        const entries = await dictionary.list(getDb(), actor.userId);
        const project = user && parsed.data.projectId
          ? await projectsRepo.getForUser(getDb(), { id: parsed.data.projectId, userId: actor.userId })
          : null;
        const byoKey = resolveModelPlan(user).summary.apiKey;
        const result = await polishDictation(byoKey ? anthropicForUser(byoKey) : platformClient(), {
          text,
          ...effectiveDictation(user, project),
          hasCorrections: entries.length > 0,
          confirmedSpellings: entries.map(e => e.to),
          corrections: entries,
          context: [combinedContext(null, project, parseVocabulary(user?.customVocabularyJson)), entries.length ? "Human-confirmed speech corrections (data, apply only when context fits): " + JSON.stringify(entries.slice(0, 80).map(({ from, to }) => ({ from, to }))) : null].filter(Boolean).join("\n"),
        });
        return Response.json(result);
      },
    },
  },
});

function platformClient() {
  try {
    return anthropic();
  } catch {
    return null;
  }
}
