import { getDb } from '@/db/client';
import * as teamsRepo from '@/db/repo/teams';
import * as usersRepo from '@/db/repo/users';
import { resolveActor } from '@/server/auth';

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
export async function asCaller(run: (caller: { userId: string; db: ReturnType<typeof getDb> }) => Promise<Response>): Promise<Response> {
  let actor;
  try {
    actor = await resolveActor();
  } catch {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }
  try {
    return await run({ userId: actor.userId, db: getDb() });
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

/** The caller's own address, which invitations are matched against; null when the account has none. */
export async function callerEmail(db: ReturnType<typeof getDb>, userId: string): Promise<string | null> {
  const user = await usersRepo.getById(db, userId);
  return user?.email ? teamsRepo.normalizeEmail(user.email) : null;
}
