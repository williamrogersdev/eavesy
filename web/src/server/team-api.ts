import { clerkClient } from '@clerk/tanstack-react-start/server';
import { getDb } from '@/db/client';
import * as teamsRepo from '@/db/repo/teams';
import * as usersRepo from '@/db/repo/users';
import { resolveActor } from '@/server/auth';
import { verifiedEmail } from '@/server/verified-email';

const STATUS: Record<teamsRepo.TeamError['code'], number> = {
  already_in_team: 409,
  already_member: 409,
  team_full: 409,
  last_owner: 409,
  not_in_team: 404,
  not_found: 404,
  forbidden: 403,
};

const MESSAGE: Record<teamsRepo.TeamError['code'], string> = {
  already_in_team: 'You’re already in a team. Leave it first.',
  already_member: 'That person is already in the team.',
  team_full: `A team holds up to ${teamsRepo.TEAM_SEAT_LIMIT} people, counting open invitations.`,
  last_owner: 'A team needs an owner. Make someone else an owner first.',
  not_in_team: 'You’re not in a team.',
  not_found: 'That’s no longer there.',
  forbidden: 'Your role in the team doesn’t allow that.',
};

export function teamFailure(code: teamsRepo.TeamError['code']): Response {
  return Response.json({ error: code, message: MESSAGE[code] }, { status: STATUS[code] });
}

/**
 * Runs a team API handler for the signed-in caller: 401 without one, and a
 * `TeamError` thrown inside becomes its status and message.
 */
export async function asCaller(
  run: (caller: { userId: string; db: ReturnType<typeof getDb>; email: () => Promise<string | null> }) => Promise<Response>,
): Promise<Response> {
  let actor;
  try {
    actor = await resolveActor();
  } catch {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    const db = getDb();
    const { userId, clerkUserId } = actor;
    return await run({ userId, db, email: () => callerEmail(db, userId, clerkUserId) });
  } catch (error) {
    if (error instanceof teamsRepo.TeamError) return teamFailure(error.code);
    throw error;
  }
}

/** The caller's team and role, or a `not_in_team` error. */
export async function requireMembership(db: ReturnType<typeof getDb>, userId: string): Promise<teamsRepo.Membership> {
  const membership = await teamsRepo.membershipOf(db, userId);
  if (!membership) throw new teamsRepo.TeamError('not_in_team');
  return membership;
}

/** As `requireMembership`, for what only owners and admins do. */
export async function requireManager(db: ReturnType<typeof getDb>, userId: string): Promise<teamsRepo.Membership> {
  const membership = await requireMembership(db, userId);
  if (!teamsRepo.canInvite(membership.role)) throw new teamsRepo.TeamError('forbidden');
  return membership;
}

/**
 * The caller's own address, which invitations are matched against; null when they have none proven.
 * Asked of the sign-in provider each time, verified addresses only: the copy on the account row
 * may predate that rule, and an invitation must only reach someone who proved they hold the address.
 * An account with no sign-in of its own (local test mode) uses its stored address.
 */
async function callerEmail(db: ReturnType<typeof getDb>, userId: string, clerkUserId: string | undefined): Promise<string | null> {
  if (clerkUserId) {
    const clerkUser = await clerkClient().users.getUser(clerkUserId);
    const email = verifiedEmail(clerkUser.emailAddresses, clerkUser.primaryEmailAddressId);
    return email ? teamsRepo.normalizeEmail(email) : null;
  }
  const user = await usersRepo.getById(db, userId);
  return user?.email ? teamsRepo.normalizeEmail(user.email) : null;
}
