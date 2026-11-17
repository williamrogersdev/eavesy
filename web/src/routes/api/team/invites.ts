import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import * as teamsRepo from '@/db/repo/teams';
import * as usersRepo from '@/db/repo/users';
import { getCloudflareContext } from '@/server/cloudflare-context';
import type { EmailEnv } from '@/server/email/resend';
import { sendTeamInvite, teamInviteLink } from '@/server/email/team-invite';
import { guardBurst, guardUserQuota } from '@/server/rate-limit';
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
          const env = getCloudflareContext<EmailEnv>().env;
          // Each invitation emails an address outside the account.
          // Without email set up nothing goes out, and the team's seat limit bounds the rows.
          if (env.RESEND_API_KEY && env.EMAIL_FROM) {
            const limited = await guardBurst(userId, 'team-invite') ?? await guardUserQuota(userId, 'team-invite');
            if (limited) return limited;
          }
          const now = Date.now();
          const id = await teamsRepo.invite(db, { teamId: membership.teamId, invitedBy: userId, ...parsed.data }, now);
          // The invitation is saved: nothing past here may fail the request.
          const inviter = await usersRepo.getById(db, userId).catch(() => null);
          const email = await sendTeamInvite(env, {
            id,
            email: teamsRepo.normalizeEmail(parsed.data.email),
            inviterName: inviter?.displayName?.trim() || inviter?.email || 'A teammate',
            inviterEmail: inviter?.email ?? null,
            teamName: membership.name,
            role: parsed.data.role,
            link: teamInviteLink(env),
            expiresAt: now + teamsRepo.INVITE_TTL_MS,
            sentAt: now,
          });
          return Response.json({ id, email, emailed: email === 'sent' });
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
