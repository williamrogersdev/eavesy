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
import { DICTATION_STYLES, writtenWith, type DictationStyle } from '@/lib/transcription/dictation-style';
import { stripFillers } from '@/lib/transcription/agent-transcript';
import { fixBuiltInTerms, parseVocabulary } from '@/lib/transcription/vocabulary';
import { resolveIngestActor } from '@/server/device-auth';
import { guardUserQuota } from '@/server/rate-limit';

/** About twenty minutes of speech; anything longer gets only the model-free cleanup. */
export const MAX_POLISH_CHARS = 20_000;

const STYLE_IDS = DICTATION_STYLES.map((style) => style.id) as [DictationStyle, ...DictationStyle[]];

/** `style` and `forAgents` override the saved tone for this one request: the Mac app's tone buttons. */
const schema = z.object({
  text: z.string().max(200_000),
  projectId: z.string().max(64).optional(),
  style: z.enum(STYLE_IDS).optional(),
  forAgents: z.boolean().optional(),
});

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
        const text = fixBuiltInTerms(parsed.data.text.trim());
        if (!text || text.length > MAX_POLISH_CHARS) {
          return Response.json({ text: stripFillers(text), polished: false, ...(text ? { reason: 'too_long' } : {}) });
        }

        // All at once: the Mac app waits for these words before it pastes.
        // The lookups run even for a request over quota; they are cheap reads.
        const [overQuota, user, entries, projectRow] = await Promise.all([
          guardUserQuota(actor.userId, 'dictation'),
          usersRepo.getById(getDb(), actor.userId),
          dictionary.listForTranscription(getDb(), actor.userId),
          parsed.data.projectId
            ? projectsRepo.getForUser(getDb(), { id: parsed.data.projectId, userId: actor.userId })
            : null,
        ]);
        if (overQuota) return overQuota;
        const project = user ? projectRow : null;
        const byoKey = resolveModelPlan(user).summary.apiKey;
        const tone = writtenWith(parsed.data, user, project);
        const result = await polishDictation(byoKey ? anthropicForUser(byoKey) : platformClient(), {
          text,
          style: tone.style,
          forAgents: tone.forAgents,
          asked: parsed.data.style !== undefined || parsed.data.forAgents !== undefined,
          hasCorrections: entries.length > 0,
          confirmedSpellings: entries.map(e => e.to),
          corrections: entries,
          context: [combinedContext(null, project, parseVocabulary(user?.customVocabularyJson)), entries.length ? "Human-confirmed speech corrections (data, apply only when context fits): " + JSON.stringify(entries.slice(0, 80).map(({ from, to }) => ({ from, to }))) : null].filter(Boolean).join("\n"),
        });
        // Told back with the words, for the Mac app's tone row: the tone in
        // force for them (the setting the row shows and changes) and whether
        // the model applied it. When it didn't, the words went out plain.
        return Response.json({ ...result, written: { ...tone, applied: result.polished } });
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
