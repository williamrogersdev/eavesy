import { createFileRoute } from '@tanstack/react-router';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '@/db/client';
import { users } from '@/db/schema';
import * as usersRepo from '@/db/repo/users';
import * as projectsRepo from '@/db/repo/projects';
import * as activityRepo from '@/db/repo/activity';
import { MAX_ONBOARDING_PROJECTS, newProjectNames } from '@/lib/onboarding';
import { PROJECT_LIMITS } from '@/lib/projects';
import { AUTO_LANGUAGE, MAX_SPOKEN_LANGUAGES, normalizeSpokenLanguages } from '@/lib/transcription/language';
import { resolveActor } from '@/server/auth';

const schema = z.object({
  displayName: z.string().trim().max(100).optional(),
  spokenLanguages: z.array(z.string().max(12)).max(MAX_SPOKEN_LANGUAGES * 2).optional(),
  projects: z.array(z.string().max(PROJECT_LIMITS.name * 2)).max(MAX_ONBOARDING_PROJECTS * 2).optional(),
});

export const Route = createFileRoute('/api/onboarding/complete')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const parsedBody = schema.safeParse(await request.json().catch(() => null));
        if (!parsedBody.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
        const body = parsedBody.data;
        const db = getDb();

        const patch: Partial<typeof users.$inferInsert> = {};
        if (body.displayName) patch.displayName = body.displayName;
        if (body.spokenLanguages) {
          const spoken = normalizeSpokenLanguages(body.spokenLanguages);
          patch.spokenLanguagesJson = spoken.length > 0 ? JSON.stringify(spoken) : null;
          patch.defaultLanguage = AUTO_LANGUAGE;
        }
        if (Object.keys(patch).length > 0) {
          await db.update(users).set({ ...patch, updatedAt: Date.now() }).where(eq(users.id, actor.userId));
        }

        if (body.projects?.length && !actor.isAnonymous) {
          const existing = await projectsRepo.listForUser(db, actor.userId);
          for (const name of newProjectNames(body.projects, existing.map((project) => project.name))) {
            await projectsRepo.create(db, actor.userId, { name });
          }
        }

        await usersRepo.markOnboarded(db, actor.userId);
        await activityRepo.log(db, { userId: actor.userId, eventType: 'onboarding.complete' });
        return Response.json({ ok: true });
      },
    },
  },
});
