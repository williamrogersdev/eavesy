import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as subsRepo from '@/db/repo/subscriptions';
import * as usersRepo from '@/db/repo/users';
import * as activityRepo from '@/db/repo/activity';
import { resolveActor } from '@/server/auth';

const schema = z.object({ plan: z.literal('free') });

export const Route = createFileRoute('/api/onboarding/complete')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        schema.parse(await request.json());
        let actor;
        try {
          actor = await resolveActor();
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        await subsRepo.setFreePlan(db, actor.userId);
        await usersRepo.markOnboarded(db, actor.userId);
        await activityRepo.log(db, { userId: actor.userId, eventType: 'onboarding.complete' });
        return Response.json({ ok: true });
      },
    },
  },
});
