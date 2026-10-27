import { createFileRoute } from '@tanstack/react-router';
import { getDb } from '@/db/client';
import * as projectsRepo from '@/db/repo/projects';
import { projectActor, projectFieldsSchema } from '@/server/project-input';

const MAX_PROJECTS = 200;

export const Route = createFileRoute('/api/projects/')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        let actor;
        try {
          actor = await projectActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const items = await projectsRepo.listForUser(getDb(), actor.userId);
        return Response.json({ items });
      },

      POST: async ({ request }) => {
        let actor;
        try {
          actor = await projectActor(request);
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsed = projectFieldsSchema.safeParse(await request.json().catch(() => null));
        if (!parsed.success) {
          return Response.json({ error: 'invalid_request', issues: parsed.error.issues }, { status: 400 });
        }
        const db = getDb();
        const existing = await projectsRepo.listForUser(db, actor.userId);
        if (existing.length >= MAX_PROJECTS) {
          return Response.json({ error: 'too_many_projects' }, { status: 409 });
        }
        const id = await projectsRepo.create(db, actor.userId, parsed.data);
        const project = await projectsRepo.getForUser(db, { id, userId: actor.userId });
        return Response.json({ project: { ...project, recordingCount: 0 } }, { status: 201 });
      },
    },
  },
});
