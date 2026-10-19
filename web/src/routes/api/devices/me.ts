import { createFileRoute } from '@tanstack/react-router';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { deviceTokens, users } from '@/db/schema';
import { parseVocabulary } from '@/lib/transcription/vocabulary';
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
        if (actor.isAnonymous) return Response.json({ error: 'unauthenticated' }, { status: 401 });
        const user = (
          await getDb()
            .select({
              email: users.email,
              displayName: users.displayName,
              customVocabularyJson: users.customVocabularyJson,
            })
            .from(users)
            .where(eq(users.id, actor.userId))
            .limit(1)
        )[0];
        return Response.json({
          email: user?.email ?? null,
          name: user?.displayName ?? null,
          vocabulary: parseVocabulary(user?.customVocabularyJson),
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
