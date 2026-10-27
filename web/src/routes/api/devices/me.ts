import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import * as dictionary from '@/db/repo/dictionary';
import { deviceTokens, users } from '@/db/schema';
import { AUTO_LANGUAGE } from '@/lib/transcription/language';
import { parseVocabulary, normalizeVocabulary } from '@/lib/transcription/vocabulary';
import { resolveIngestActor, sha256Hex } from '@/server/device-auth';

export const Route = createFileRoute('/api/devices/me')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await resolveIngestActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const user = (
          await getDb()
            .select({
              email: users.email,
              displayName: users.displayName,
              customVocabularyJson: users.customVocabularyJson,
              defaultLanguage: users.defaultLanguage,
            })
            .from(users)
            .where(eq(users.id, actor.userId))
            .limit(1)
        )[0];
        // Normalize in priority order, then store oldest first because the Mac
        // takes the last 100 cached words. Confirmed spellings beat manual duplicates.
        const learnedNewestFirst = (await dictionary.listForTranscription(getDb(), actor.userId)).map(e => e.to);
        const vocabulary = normalizeVocabulary([
          ...learnedNewestFirst, ...parseVocabulary(user?.customVocabularyJson).reverse(),
        ]).reverse();
        return Response.json({
          email: user?.email ?? null,
          name: user?.displayName ?? null,
          vocabulary,
          language: user?.defaultLanguage || AUTO_LANGUAGE,
        });
      },
      DELETE: async ({ request }) => {
        const authorization = request.headers.get('authorization') ?? '';
        const rawToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
        if (!rawToken) return Response.json({ error: 'unauthenticated' }, { status: 401 });
        await getDb()
          .update(deviceTokens)
          .set({ revokedAt: Date.now() })
          .where(and(eq(deviceTokens.tokenHash, await sha256Hex(rawToken)), isNull(deviceTokens.revokedAt)));
        return new Response(null, { status: 204 });
      },
    },
  },
});
