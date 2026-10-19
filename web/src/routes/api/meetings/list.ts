import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveActor } from '@/server/auth';

export const Route = createFileRoute('/api/meetings/list')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        let actor;
        try {
          actor = await resolveActor({
            anonymousSessionToken: url.searchParams.get('anonymousSessionToken') ?? undefined,
          });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 200);
        const beforeParam = Number(url.searchParams.get('before'));
        const before = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : undefined;
        const items = await meetingsRepo.listSummariesForUser(getDb(), { userId: actor.userId, limit, before });
        const nextBefore = items.length === limit ? items[items.length - 1]?.startedAt ?? null : null;
        return Response.json({ items, nextBefore });
      },
    },
  },
});
