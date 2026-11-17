import { createFileRoute } from '@tanstack/react-router';
import { listTeamRecordings } from '@/db/repo/team-access';
import { clampLimit } from '@/lib/http/clamp-limit';
import { asCaller, requireManager } from '@/server/team-api';

export const Route = createFileRoute('/api/team/recordings')({
  server: {
    handlers: {
      /** Teammates' recordings since they joined, for the team's owners and admins. */
      GET: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          await requireManager(db, userId);
          const url = new URL(request.url);
          const limit = clampLimit(url.searchParams.get('limit'), 50, 200);
          const beforeParam = Number(url.searchParams.get('before'));
          const before = Number.isFinite(beforeParam) && beforeParam > 0 ? beforeParam : undefined;
          const items = await listTeamRecordings(db, { viewerId: userId, limit, before });
          const nextBefore = items.length === limit ? (items[items.length - 1]?.startedAt ?? null) : null;
          return Response.json({ items, nextBefore });
        }),
    },
  },
});
