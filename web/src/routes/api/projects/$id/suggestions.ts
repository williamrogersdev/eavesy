import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as projectsRepo from '@/db/repo/projects';
import { projectActor } from '@/server/project-input';

export const Route = createFileRoute('/api/projects/$id/suggestions')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        let actor;
        try {
          actor = await projectActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const terms = await projectsRepo.vocabularySuggestions(getDb(), { id: params.id, userId: actor.userId });
        if (!terms) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ terms });
      },
    },
  },
});
