import { and, asc, desc, eq, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { captures, folders, meetings, summaries } from '../schema';
import { contextFor, membershipOf } from './teams';
import { cleanList, parseStringList, PROJECT_LIMITS, type Project, type TeamContext } from '@/lib/projects';
import { isDictationStyle, type DictationStyle } from '@/lib/transcription/dictation-style';

type FolderRow = typeof folders.$inferSelect;

/**
 * Who sees and uses a project, and who changes it.
 *
 * A project is its creator's (`user_id`) until they share it with their team
 * (`team_id`). Then every member of that team sees it, files their own
 * recordings into it, and their transcripts and notes use its context. Its
 * creator and the team's owners and admins edit, unshare and delete it.
 * Sharing never shows anyone else's recordings: those stay with their authors.
 */
const teamOf = (userId: string) => sql`(SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${userId})`;
const managedTeamOf = (userId: string) =>
  sql`(SELECT tm.team_id FROM team_members tm WHERE tm.user_id = ${userId} AND tm.role IN ('owner', 'admin'))`;

/** Projects `userId` sees and may file into: their own, and their team's. */
function usable(userId: string): SQL {
  return or(eq(folders.userId, userId), sql`${folders.teamId} = ${teamOf(userId)}`)!;
}

/** Projects `userId` may edit, unshare or delete: their own, and their team's if they own or manage it. */
function editable(userId: string): SQL {
  return or(eq(folders.userId, userId), sql`${folders.teamId} = ${managedTeamOf(userId)}`)!;
}

const canEditColumn = (userId: string) =>
  sql<number>`(${folders.userId} = ${userId} OR ${folders.teamId} = ${managedTeamOf(userId)})`;

export interface ProjectWithCount extends Project {
  recordingCount: number;
}

export function toProject(row: FolderRow): Project {
  return {
    id: row.id,
    name: row.name,
    about: row.about,
    vocabulary: parseStringList(row.vocabularyJson),
    people: row.people,
    match: parseStringList(row.matchJson),
    dictationStyle: isDictationStyle(row.dictationStyle) ? row.dictationStyle : null,
    dictationForAgents: row.dictationForAgents ?? null,
    shared: row.teamId !== null,
  };
}

function withAccess(row: FolderRow, canEdit: unknown): Project {
  return { ...toProject(row), canEdit: Boolean(Number(canEdit)) };
}

export async function listForUser(db: AppDb, userId: string): Promise<ProjectWithCount[]> {
  const rows = await db
    .select({
      folder: folders,
      canEdit: canEditColumn(userId),
      // Your own recordings in it: a shared project's other recordings are their authors'.
      recordingCount: sql<number>`(select count(*) from meetings m where m.folder_id = "folders"."id" and m.user_id = ${userId} and m.deleted_at is null)`,
    })
    .from(folders)
    .where(usable(userId))
    // Your own first, then the team's.
    .orderBy(sql`${folders.userId} <> ${userId}`, asc(folders.sortOrder), asc(folders.name));
  return rows.map((row) => ({ ...withAccess(row.folder, row.canEdit), recordingCount: Number(row.recordingCount) || 0 }));
}

/** A project `userId` can see and use: their own or their team's. */
export async function getForUser(db: AppDb, args: { id: string; userId: string }): Promise<Project | null> {
  const row = (
    await db
      .select({ folder: folders, canEdit: canEditColumn(args.userId) })
      .from(folders)
      .where(and(eq(folders.id, args.id), usable(args.userId)))
      .limit(1)
  )[0];
  return row ? withAccess(row.folder, row.canEdit) : null;
}

export async function getForMeeting(
  db: AppDb,
  meeting: { folderId: string | null; userId: string },
): Promise<Project | null> {
  if (!meeting.folderId) return null;
  return await getForUser(db, { id: meeting.folderId, userId: meeting.userId });
}

/** Everything a recording's transcript and notes are told about where it belongs: its project, and its author's team. */
export async function contextForMeeting(
  db: AppDb,
  meeting: { folderId: string | null; userId: string },
): Promise<{ project: Project | null; team: TeamContext | null }> {
  const [project, team] = await Promise.all([getForMeeting(db, meeting), contextFor(db, meeting.userId)]);
  return { project, team };
}

export interface ProjectInput {
  name?: string;
  about?: string | null;
  vocabulary?: string[];
  people?: string | null;
  match?: string[];
  dictationStyle?: DictationStyle | null;
  dictationForAgents?: boolean | null;
  /** Share with the editor's team, or keep to the creator. */
  shared?: boolean;
}

function columns(input: Omit<ProjectInput, 'shared'>) {
  return {
    ...(input.name !== undefined ? { name: input.name.trim().slice(0, PROJECT_LIMITS.name) } : {}),
    ...(input.about !== undefined ? { about: input.about?.trim().slice(0, PROJECT_LIMITS.about) || null } : {}),
    ...(input.people !== undefined ? { people: input.people?.trim().slice(0, PROJECT_LIMITS.people) || null } : {}),
    ...(input.vocabulary !== undefined ? { vocabularyJson: JSON.stringify(cleanList(input.vocabulary)) } : {}),
    ...(input.match !== undefined
      ? { matchJson: JSON.stringify(cleanList(input.match, PROJECT_LIMITS.match)) }
      : {}),
    ...(input.dictationStyle !== undefined ? { dictationStyle: input.dictationStyle } : {}),
    ...(input.dictationForAgents !== undefined ? { dictationForAgents: input.dictationForAgents } : {}),
  };
}

export async function create(db: AppDb, userId: string, input: ProjectInput & { name: string }): Promise<string> {
  const id = pid('proj');
  const now = Date.now();
  const last = (
    await db
      .select({ max: sql<number>`coalesce(max(${folders.sortOrder}), -1)` })
      .from(folders)
      .where(eq(folders.userId, userId))
  )[0];
  await db.insert(folders).values({
    id,
    userId,
    name: input.name.trim().slice(0, PROJECT_LIMITS.name),
    sortOrder: (Number(last?.max) || 0) + 1,
    vocabularyJson: '[]',
    matchJson: '[]',
    ...columns(input),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export type UpdateResult = 'ok' | 'not_found' | 'forbidden' | 'no_team';

/**
 * Edits a project `userId` may edit. Sharing puts it in their own team; a
 * teammate who can only use it gets `forbidden`. Unsharing takes it out of
 * the teammates' recordings and captures, which stay theirs, unfiled.
 */
export async function update(db: AppDb, args: { id: string; userId: string } & ProjectInput): Promise<UpdateResult> {
  const { id, userId, shared, ...input } = args;
  const current = (
    await db
      .select({ ownerId: folders.userId, teamId: folders.teamId, canEdit: canEditColumn(userId) })
      .from(folders)
      .where(and(eq(folders.id, id), usable(userId)))
      .limit(1)
  )[0];
  if (!current) return 'not_found';
  if (!Number(current.canEdit)) return 'forbidden';
  let teamId: string | null | undefined;
  if (shared === true && current.teamId === null) {
    teamId = (await membershipOf(db, userId))?.teamId ?? null;
    if (!teamId) return 'no_team';
  } else if (shared === false && current.teamId !== null) {
    teamId = null;
  }
  const writes = [
    db
      .update(folders)
      .set({ ...columns(input), ...(teamId !== undefined ? { teamId } : {}), updatedAt: Date.now() })
      .where(and(eq(folders.id, id), editable(userId))),
  ] as const;
  if (teamId === null) {
    await db.batch([
      ...writes,
      db.update(meetings).set({ folderId: null }).where(and(eq(meetings.folderId, id), ne(meetings.userId, current.ownerId))),
      db.update(captures).set({ folderId: null }).where(and(eq(captures.folderId, id), ne(captures.userId, current.ownerId))),
    ]);
  } else {
    await db.batch(writes);
  }
  return 'ok';
}

/** Deletes a project `userId` may edit; everyone's recordings in it stay, and simply lose the project. */
export async function remove(db: AppDb, args: { id: string; userId: string }): Promise<boolean> {
  const deleted = await db
    .delete(folders)
    .where(and(eq(folders.id, args.id), editable(args.userId)))
    .returning({ id: folders.id });
  if (deleted.length === 0) return false;
  await db.batch([
    db.update(meetings).set({ folderId: null }).where(eq(meetings.folderId, args.id)),
    db.update(captures).set({ folderId: null }).where(eq(captures.folderId, args.id)),
  ]);
  return true;
}

/** Whether `userId` may file things into this project: their own, or their team's. */
export async function canUseProject(db: AppDb, userId: string, projectId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, projectId), usable(userId)))
      .limit(1)
  )[0];
  return Boolean(row);
}

const SUGGESTION_MEETINGS = 30;
const SUGGESTION_LIMIT = 8;

/**
 * Products, projects and companies the project's recent summaries mention
 * that are not in its vocabulary yet, most mentioned first.
 */
export async function vocabularySuggestions(db: AppDb, args: { id: string; userId: string }): Promise<string[] | null> {
  const project = await getForUser(db, args);
  if (!project) return null;
  const rows = await db
    .select({ mentionsJson: summaries.mentionsJson })
    .from(summaries)
    .innerJoin(meetings, eq(meetings.id, summaries.meetingId))
    .where(and(eq(meetings.userId, args.userId), eq(meetings.folderId, args.id), isNull(meetings.deletedAt)))
    .orderBy(desc(meetings.startedAt))
    .limit(SUGGESTION_MEETINGS);
  const known = new Set([...project.vocabulary, project.name].map((term) => term.toLowerCase()));
  const counts = new Map<string, { term: string; count: number }>();
  for (const row of rows) {
    let mentions: unknown;
    try {
      mentions = JSON.parse(row.mentionsJson);
    } catch {
      continue;
    }
    if (!Array.isArray(mentions)) continue;
    for (const mention of mentions) {
      if (typeof mention !== 'object' || mention === null) continue;
      const { entity, type } = mention as { entity?: unknown; type?: unknown };
      if (typeof entity !== 'string' || type === 'person') continue;
      const term = entity.trim();
      const key = term.toLowerCase();
      if (!term || term.length > PROJECT_LIMITS.term || known.has(key)) continue;
      const entry = counts.get(key) ?? { term, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.term);
}
