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
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 200);
        const items = await meetingsRepo.listForUser(getDb(), { userId: actor.userId, limit });
        return Response.json({ items });
      },
    },
  },
});
