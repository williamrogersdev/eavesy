import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { teamInvites, teamMembers, teams, users } from '../schema';

export type TeamRole = (typeof teamMembers.$inferSelect)['role'];
export type InviteRole = (typeof teamInvites.$inferSelect)['role'];

/** Members and open invitations one team may hold together. */
export const TEAM_SEAT_LIMIT = 50;
export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_TEAM_NAME = 80;

/** Thrown with a code the API hands straight to the client. */
export class TeamError extends Error {
  constructor(readonly code: 'already_in_team' | 'not_in_team' | 'forbidden' | 'not_found' | 'team_full' | 'already_member' | 'last_owner') {
    super(code);
  }
}

/** Whether `actor` may remove `target` or change their role. Owners manage everyone; admins manage members. */
export function canManage(actor: TeamRole, target: TeamRole): boolean {
  if (actor === 'owner') return true;
  return actor === 'admin' && target === 'member';
}

/** Owners and admins invite people and rename the team. */
export function canInvite(role: TeamRole): boolean {
  return role !== 'member';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface Membership {
  teamId: string;
  name: string;
  role: TeamRole;
}

export async function membershipOf(db: AppDb, userId: string): Promise<Membership | null> {
  const rows = await db
    .select({ teamId: teams.id, name: teams.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMembers(db: AppDb, teamId: string) {
  return await db
    .select({ userId: users.id, name: users.displayName, email: users.email, role: teamMembers.role, joinedAt: teamMembers.createdAt })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(teamMembers.createdAt));
}

export async function listInvites(db: AppDb, teamId: string, now = Date.now()) {
  return await db
    .select({ id: teamInvites.id, email: teamInvites.email, role: teamInvites.role, expiresAt: teamInvites.expiresAt })
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, teamId), gt(teamInvites.expiresAt, now)))
    .orderBy(asc(teamInvites.createdAt));
}

/** Open invitations addressed to this email, with the team's name. */
export async function invitesFor(db: AppDb, email: string, now = Date.now()) {
  return await db
    .select({ id: teamInvites.id, teamName: teams.name, role: teamInvites.role })
    .from(teamInvites)
    .innerJoin(teams, eq(teams.id, teamInvites.teamId))
    .where(and(eq(teamInvites.email, normalizeEmail(email)), gt(teamInvites.expiresAt, now)))
    .orderBy(asc(teamInvites.createdAt));
}

/** Makes a team with `userId` as its owner. One person is in one team: the unique index refuses a second. */
export async function create(db: AppDb, args: { userId: string; name: string }, now = Date.now()): Promise<string> {
  if (await membershipOf(db, args.userId)) throw new TeamError('already_in_team');
  const id = pid('team');
  try {
    await db.batch([
      db.insert(teams).values({ id, name: args.name, createdBy: args.userId, createdAt: now, updatedAt: now }),
      db.insert(teamMembers).values({ teamId: id, userId: args.userId, role: 'owner', createdAt: now }),
    ]);
  } catch (error) {
    // Two creates at once: the membership index let one through.
    if (await membershipOf(db, args.userId)) throw new TeamError('already_in_team');
    throw error;
  }
  return id;
}

export async function rename(db: AppDb, args: { teamId: string; name: string }, now = Date.now()) {
  await db.update(teams).set({ name: args.name, updatedAt: now }).where(eq(teams.id, args.teamId));
}

/**
 * Invites an email address, or renews and re-roles an invitation it already has.
 * The seat check and the insert are one statement, so two invites can't both take the last seat.
 */
export async function invite(
  db: AppDb,
  args: { teamId: string; email: string; role: InviteRole; invitedBy: string },
  now = Date.now(),
): Promise<string> {
  const email = normalizeEmail(args.email);
  const member = await db
    .select({ id: users.id })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .where(and(eq(teamMembers.teamId, args.teamId), sql`lower(${users.email}) = ${email}`))
    .limit(1);
  if (member[0]) throw new TeamError('already_member');

  const existing = await db
    .select({ id: teamInvites.id })
    .from(teamInvites)
    .where(and(eq(teamInvites.teamId, args.teamId), eq(teamInvites.email, email)))
    .limit(1);
  if (existing[0]) {
    await db.update(teamInvites).set({ role: args.role, expiresAt: now + INVITE_TTL_MS }).where(eq(teamInvites.id, existing[0].id));
    return existing[0].id;
  }

  const id = pid('tinv');
  const rows = await db.insert(teamInvites).select(sql`
    SELECT ${id}, ${args.teamId}, ${email}, ${args.role}, ${args.invitedBy}, ${now}, ${now + INVITE_TTL_MS}
    WHERE (SELECT count(*) FROM team_members WHERE team_id = ${args.teamId})
        + (SELECT count(*) FROM team_invites WHERE team_id = ${args.teamId} AND expires_at > ${now}) < ${TEAM_SEAT_LIMIT}
  `).returning({ id: teamInvites.id });
  if (!rows[0]) throw new TeamError('team_full');
  return id;
}

export async function revokeInvite(db: AppDb, args: { teamId: string; id: string }) {
  await db.delete(teamInvites).where(and(eq(teamInvites.id, args.id), eq(teamInvites.teamId, args.teamId)));
}

/** The invitation, only if it is open and addressed to this email. */
async function inviteFor(db: AppDb, args: { id: string; email: string }, now: number) {
  const rows = await db
    .select()
    .from(teamInvites)
    .where(and(eq(teamInvites.id, args.id), eq(teamInvites.email, normalizeEmail(args.email)), gt(teamInvites.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
}

/** Joins the team an invitation is for. The caller's own email must be the invited one. */
export async function acceptInvite(db: AppDb, args: { id: string; userId: string; email: string }, now = Date.now()): Promise<string> {
  const found = await inviteFor(db, args, now);
  if (!found) throw new TeamError('not_found');
  if (await membershipOf(db, args.userId)) throw new TeamError('already_in_team');
  try {
    await db.batch([
      db.insert(teamMembers).values({ teamId: found.teamId, userId: args.userId, role: found.role, createdAt: now }),
      db.delete(teamInvites).where(eq(teamInvites.id, found.id)),
    ]);
  } catch (error) {
    if (await membershipOf(db, args.userId)) throw new TeamError('already_in_team');
    throw error;
  }
  return found.teamId;
}

export async function declineInvite(db: AppDb, args: { id: string; email: string }, now = Date.now()) {
  const found = await inviteFor(db, args, now);
  if (found) await db.delete(teamInvites).where(eq(teamInvites.id, found.id));
}

async function roleIn(db: AppDb, teamId: string, userId: string): Promise<TeamRole | null> {
  const rows = await db
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

async function ownerCount(db: AppDb, teamId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.role, 'owner')));
  return rows[0]?.n ?? 0;
}

/** Changes someone's role. Only an owner does this, and the last owner can't be demoted. */
export async function setRole(db: AppDb, args: { teamId: string; actorRole: TeamRole; userId: string; role: TeamRole }) {
  if (args.actorRole !== 'owner') throw new TeamError('forbidden');
  const current = await roleIn(db, args.teamId, args.userId);
  if (!current) throw new TeamError('not_found');
  if (current === 'owner' && args.role !== 'owner' && (await ownerCount(db, args.teamId)) <= 1) throw new TeamError('last_owner');
  await db
    .update(teamMembers)
    .set({ role: args.role })
    .where(and(eq(teamMembers.teamId, args.teamId), eq(teamMembers.userId, args.userId)));
}

/** Removes someone else from the team. To leave yourself, use `depart`. */
export async function removeMember(db: AppDb, args: { teamId: string; actorRole: TeamRole; userId: string }) {
  const target = await roleIn(db, args.teamId, args.userId);
  if (!target) throw new TeamError('not_found');
  if (!canManage(args.actorRole, target)) throw new TeamError('forbidden');
  if (target === 'owner' && (await ownerCount(db, args.teamId)) <= 1) throw new TeamError('last_owner');
  await db.delete(teamMembers).where(and(eq(teamMembers.teamId, args.teamId), eq(teamMembers.userId, args.userId)));
}

/**
 * What runs, in order, when `?1` leaves their team or their account is deleted.
 * A team keeps an owner: if they were the only one, the longest-standing admin
 * (else member) becomes it. A team left with nobody is deleted with its invitations.
 * Plain SQL so the account purge, which has only the D1 binding, runs the same steps.
 */
export const DEPART_STATEMENTS = [
  `UPDATE team_members SET role = 'owner'
    WHERE rowid = (
      SELECT next.rowid FROM team_members next
      WHERE next.team_id = (SELECT team_id FROM team_members WHERE user_id = ?1 AND role = 'owner')
        AND next.user_id <> ?1
        AND NOT EXISTS (
          SELECT 1 FROM team_members other
          WHERE other.team_id = next.team_id AND other.role = 'owner' AND other.user_id <> ?1
        )
      ORDER BY (next.role = 'admin') DESC, next.created_at ASC, next.user_id ASC
      LIMIT 1
    )`,
  `DELETE FROM team_members WHERE user_id = ?1`,
  // `?1 IS NOT NULL` only so every statement takes the same one binding.
  `DELETE FROM team_invites WHERE ?1 IS NOT NULL AND team_id NOT IN (SELECT team_id FROM team_members)`,
  `DELETE FROM teams WHERE ?1 IS NOT NULL AND id NOT IN (SELECT team_id FROM team_members)`,
] as const;

/** Leaves the team (see `DEPART_STATEMENTS`), as one transaction. */
export async function depart(d1: D1Database, userId: string) {
  await d1.batch(DEPART_STATEMENTS.map((statement) => d1.prepare(statement).bind(userId)));
}

/** Deletes the team for everyone. Only an owner does this. */
export async function removeTeam(db: AppDb, args: { teamId: string; actorRole: TeamRole }) {
  if (args.actorRole !== 'owner') throw new TeamError('forbidden');
  await db.batch([
    db.delete(teamInvites).where(eq(teamInvites.teamId, args.teamId)),
    db.delete(teamMembers).where(eq(teamMembers.teamId, args.teamId)),
    db.delete(teams).where(eq(teams.id, args.teamId)),
  ]);
}

/** Drops invitations nobody accepted in time. */
export async function purgeExpiredInvites(db: AppDb, now = Date.now()) {
  await db.delete(teamInvites).where(lte(teamInvites.expiresAt, now));
}
