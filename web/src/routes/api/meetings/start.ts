import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { getDb } from '@/db/client';
import * as activityRepo from '@/db/repo/activity';
import * as meetingsRepo from '@/db/repo/meetings';
import { resolveActor } from '@/server/auth';

const schema = z.object({
  source: z.enum(['desktop', 'web', 'public', 'ios', 'android', 'import']).default('web'),
  title: z.string().max(200).optional(),
  language: z.string().max(10).optional(),
  localFolderSlug: z.string().max(200).optional(),
  anonymousSessionToken: z.string().optional(),
});

export const Route = createFileRoute('/api/meetings/start')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const body = schema.parse(await request.json());
        let actor;
        try {
          actor = await resolveActor({ anonymousSessionToken: body.anonymousSessionToken });
        } catch {
          return Response.json({ error: 'unauthenticated' }, { status: 401 });
        }
        const db = getDb();
        const meetingId = await meetingsRepo.start(db, {
          userId: actor.userId,
          isAnonymous: actor.isAnonymous,
          source: body.source,
          title: body.title,
          language: body.language,
          localFolderSlug: body.localFolderSlug,
        });
        await activityRepo.log(db, {
          userId: actor.userId,
          eventType: 'meeting.start',
          meetingId,
          metadata: { source: body.source },
        });
        return Response.json({ meetingId, userId: actor.userId });
      },
    },
  },
});
