import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { AppDb } from '../client';
import { meetingAttachments, meetings, teamMembers, users } from '../schema';

/**
 * What a team's owners and admins may see of their teammates' work.
 *
 * Owners and admins can read every recording a teammate made while in the
 * team: from the moment they joined (`team_members.created_at`) on. Earlier
 * recordings stay private, judged by when the device says recording began
 * (`recorded_at`), so one made offline before joining and uploaded after stays
 * private too. Imports are left out: an imported file can be of any age. Reading never grants writing: every route that
 * changes a recording still filters by its own user, so a team reader can't
 * rename, move, regenerate, share or delete someone else's recording.
 * Leaving the team ends the access, since the membership row is what grants it.
 */

const viewer = alias(teamMembers, 'viewer');
const author = alias(teamMembers, 'author');

/** Joins that put the recording's author and the viewer in the same team. */
const sameTeam = [eq(author.userId, meetings.userId), eq(viewer.teamId, author.teamId)] as const;

/** Rows of `meetings` the viewer may read as a team owner or admin (never their own; those they read as the owner). */
function teamReadable(viewerId: string) {
  return and(
    eq(viewer.userId, viewerId),
    inArray(viewer.role, ['owner', 'admin']),
    ne(meetings.userId, viewerId),
    isNull(meetings.deletedAt),
    ne(meetings.source, 'import'),
    sql`coalesce(${meetings.recordedAt}, ${meetings.startedAt}) >= ${author.createdAt}`,
  );
}

/** The recording's author if `viewerId` may read it as their team's owner or admin, else null. */
export async function teamReadableMeeting(db: AppDb, args: { viewerId: string; meetingId: string }) {
  const rows = await db
    .select({ ownerId: meetings.userId, ownerName: users.displayName, ownerEmail: users.email })
    .from(meetings)
    .innerJoin(author, sameTeam[0])
    .innerJoin(viewer, sameTeam[1])
    .innerJoin(users, eq(users.id, meetings.userId))
    .where(and(eq(meetings.id, args.meetingId), teamReadable(args.viewerId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Whether `viewerId` may stream this stored audio as their team's owner or admin. */
export async function teamReadableAudio(db: AppDb, args: { viewerId: string; key: string }): Promise<boolean> {
  const rows = await db
    .select({ id: meetings.id })
    .from(meetings)
    .innerJoin(author, sameTeam[0])
    .innerJoin(viewer, sameTeam[1])
    .where(and(eq(meetings.audioR2Key, args.key), teamReadable(args.viewerId)))
    .limit(1);
  return rows.length > 0;
}

/** Whether `viewerId` may load this screenshot or screen snapshot of a recording they can read as their team's owner or admin. */
export async function teamReadableAttachment(db: AppDb, args: { viewerId: string; key: string }): Promise<boolean> {
  const rows = await db
    .select({ id: meetingAttachments.id })
    .from(meetingAttachments)
    .innerJoin(meetings, eq(meetings.id, meetingAttachments.meetingId))
    .innerJoin(author, sameTeam[0])
    .innerJoin(viewer, sameTeam[1])
    .where(and(eq(meetingAttachments.r2Key, args.key), teamReadable(args.viewerId)))
    .limit(1);
  return rows.length > 0;
}

/** Teammates' recordings an owner or admin can read, newest first. Empty for members and people with no team. */
export async function listTeamRecordings(db: AppDb, args: { viewerId: string; limit?: number; before?: number }) {
  return await db
    .select({
      id: meetings.id,
      title: meetings.title,
      startedAt: meetings.startedAt,
      durationSec: meetings.durationSec,
      status: meetings.status,
      platform: meetings.platform,
      ownerId: meetings.userId,
      ownerName: users.displayName,
      ownerEmail: users.email,
    })
    .from(meetings)
    .innerJoin(author, sameTeam[0])
    .innerJoin(viewer, sameTeam[1])
    .innerJoin(users, eq(users.id, meetings.userId))
    .where(and(teamReadable(args.viewerId), args.before === undefined ? undefined : lt(meetings.startedAt, args.before)))
    .orderBy(desc(meetings.startedAt))
    .limit(args.limit ?? 50);
}
