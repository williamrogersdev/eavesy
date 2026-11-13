import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import * as teamsRepo from '@/db/repo/teams';
import { asCaller, requireMembership } from '@/server/team-api';

const roleSchema = z.object({ userId: z.string().min(1).max(100), role: z.enum(['owner', 'admin', 'member']) });
const removeSchema = z.object({ userId: z.string().min(1).max(100) });

export const Route = createFileRoute('/api/team/members')({
  server: {
    handlers: {
      /** Changes a member's role (owners only). */
      PATCH: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = roleSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const membership = await requireMembership(db, userId);
          await teamsRepo.setRole(db, { teamId: membership.teamId, actorRole: membership.role, ...parsed.data });
          return Response.json({ ok: true });
        }),

      /** Removes someone else from the caller's team. Leaving is `DELETE /api/team`. */
      DELETE: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = removeSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success || parsed.data.userId === userId) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const membership = await requireMembership(db, userId);
          await teamsRepo.removeMember(db, { teamId: membership.teamId, actorRole: membership.role, userId: parsed.data.userId });
          return Response.json({ ok: true });
        }),
    },
  },
});
