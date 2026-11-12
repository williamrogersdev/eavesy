import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import * as teamsRepo from '@/db/repo/teams';
import { asCaller, requireManager, requireMembership } from '@/server/team-api';

const nameSchema = z.object({ name: z.string().trim().min(1).max(teamsRepo.MAX_TEAM_NAME) });

export const Route = createFileRoute('/api/team')({
  server: {
    handlers: {
      /** The caller's team with its people, or the invitations waiting for them. */
      GET: async () =>
        asCaller(async (caller) => {
          const { userId, db } = caller;
          const membership = await teamsRepo.membershipOf(db, userId);
          if (!membership) {
            const email = await caller.email();
            return Response.json({ team: null, invitations: email ? await teamsRepo.invitesFor(db, email) : [] });
          }
          const [members, invites] = await Promise.all([
            teamsRepo.listMembers(db, membership.teamId),
            teamsRepo.canInvite(membership.role) ? teamsRepo.listInvites(db, membership.teamId) : Promise.resolve([]),
          ]);
          return Response.json({
            team: { id: membership.teamId, name: membership.name, role: membership.role },
            me: userId,
            members,
            invites,
          });
        }),

      /** Makes a team; the caller becomes its owner. */
      POST: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = nameSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const id = await teamsRepo.create(db, { userId, name: parsed.data.name });
          return Response.json({ id });
        }),

      /** Renames the team. */
      PATCH: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const parsed = nameSchema.safeParse(await request.json().catch(() => null));
          if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
          const membership = await requireManager(db, userId);
          await teamsRepo.rename(db, { teamId: membership.teamId, name: parsed.data.name });
          return Response.json({ ok: true });
        }),

      /** `?everyone=1` deletes the team (owners only); otherwise the caller leaves it. */
      DELETE: async ({ request }) =>
        asCaller(async ({ userId, db }) => {
          const membership = await requireMembership(db, userId);
          if (new URL(request.url).searchParams.get('everyone') === '1') {
            await teamsRepo.removeTeam(db, { teamId: membership.teamId, actorRole: membership.role });
          } else {
            await teamsRepo.depart(db, userId);
          }
          return Response.json({ ok: true });
        }),
    },
  },
});
