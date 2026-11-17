import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import { teamReadableAttachment } from '@/db/repo/team-access';
import { resolveActor } from '@/server/auth';
import { serveR2Object } from '@/server/r2-ranged';
import { safeMediaType } from '@/lib/http/media-type';

export const Route = createFileRoute('/api/media/$')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const path = params._splat ?? '';
        if (!path) return json({ error: 'bad key' }, 400);

        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return json({ error: 'unauthenticated' }, 401);
        }

        const [scope, ownerId] = path.split('/');
        if (scope !== 'users' || !ownerId) return json({ error: 'invalid media path' }, 400);
        // Your own media, or a screenshot in a teammate's recording you can read as the team's owner or admin.
        if (ownerId !== actor.userId && !(await teamReadableAttachment(getDb(), { viewerId: actor.userId, key: path }))) {
          return json({ error: 'forbidden' }, 403);
        }

        const response = await serveR2Object(
          request,
          path,
          new Headers({
            'cache-control': 'private, max-age=3600',
            'x-content-type-options': 'nosniff',
          }),
          safeMediaType,
        );
        return response ?? json({ error: 'not found' }, 404);
      },
    },
  },
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
