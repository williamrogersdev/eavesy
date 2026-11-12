import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import * as teamsRepo from '@/db/repo/teams';
import { asCaller, requireManager } from '@/server/team-api';

const inviteSchema = z.object({ email: z.string().trim().email().max(320), role: z.enum(['admin', 'member']).default('member') });
const revokeSchema = z.object({ id: z.string().min(1).max(100) });

export const Route = createFileRoute('/api/team/invites')({
  server: {
    handlers: {
      /** Invites an email address to the caller's team (owners and admins). */
      POST: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = inviteSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const membership = await requireManager(db, userId);
          // Only an owner hands out the admin role.
          if (parsed.data.role === 'admin' && membership.role !== 'owner') throw new teamsRepo.TeamError('forbidden');
          const id = await teamsRepo.invite(db, { teamId: membership.teamId, invitedBy: userId, ...parsed.data });
          return Response.json({ id });
        }),

      /** Takes back an invitation from the caller's team. */
      DELETE: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const membership = await requireManager(db, userId);
          await teamsRepo.revokeInvite(db, { teamId: membership.teamId, id: parsed.data.id });
          return Response.json({ ok: true });
        }),
    },
  },
});
