import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import * as teamsRepo from '@/db/repo/teams';
import { asCaller, callerEmail } from '@/server/team-api';

const answerSchema = z.object({ id: z.string().min(1).max(100), accept: z.boolean() });

export const Route = createFileRoute('/api/team/invites/answer')({
  server: {
    handlers: {
      /** Accepts or declines an invitation addressed to the caller's own email. */
      POST: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = answerSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const email = await callerEmail(db, userId);
          if (!email) throw new teamsRepo.TeamError('not_found');
          if (parsed.data.accept) await teamsRepo.acceptInvite(db, { id: parsed.data.id, userId, email });
          else await teamsRepo.declineInvite(db, { id: parsed.data.id, email });
          return Response.json({ ok: true });
        }),
    },
  },
});
