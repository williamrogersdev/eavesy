import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as projectsRepo from '@/db/repo/projects';
import { projectActor, projectFieldsSchema } from '@/server/project-input';

const patchSchema = projectFieldsSchema.partial();

export const Route = createFileRoute('/api/projects/$id/')({
  server: {
    handlers: {
      PATCH: async ({ request, params }) => {
        let actor;
        try {
          actor = await projectActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = patchSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }
        const db = getDb();
        const result = await projectsRepo.update(db, { id: params.id, userId: actor.userId, ...parsed.data });
        if (result === 'not_found') return Response.json({ error: 'not found' }, { status: 404 });
        if (result === 'forbidden') {
          return Response.json({ error: 'forbidden', message: 'Only whoever made this project, or the team’s owners and admins, can change it.' }, { status: 403 });
        }
        if (result === 'no_team') return Response.json({ error: 'no_team', message: 'Join or start a team to share projects.' }, { status: 409 });
        const project = await projectsRepo.getForUser(db, { id: params.id, userId: actor.userId });
        return Response.json({ project });
      },

      DELETE: async ({ request, params }) => {
        let actor;
        try {
          actor = await projectActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const removed = await projectsRepo.remove(getDb(), { id: params.id, userId: actor.userId });
        if (!removed) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ok: true });
      },
    },
  },
});
