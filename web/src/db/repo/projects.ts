import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { captures, folders, meetings, summaries } from '../schema';
import { cleanList, parseStringList, PROJECT_LIMITS, type Project } from '@/lib/projects';

type FolderRow = typeof folders.$inferSelect;

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
  };
}

export async function listForUser(db: AppDb, userId: string): Promise<ProjectWithCount[]> {
  const rows = await db
    .select({
      folder: folders,
      recordingCount: sql<number>`(select count(*) from ${meetings} where ${meetings.folderId} = ${folders.id} and ${meetings.deletedAt} is null)`,
    })
    .from(folders)
    .where(eq(folders.userId, userId))
    .orderBy(asc(folders.sortOrder), asc(folders.name));
  return rows.map((row) => ({ ...toProject(row.folder), recordingCount: Number(row.recordingCount) || 0 }));
}

export async function getForUser(db: AppDb, args: { id: string; userId: string }): Promise<Project | null> {
  const row = (
    await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, args.id), eq(folders.userId, args.userId)))
      .limit(1)
  )[0];
  return row ? toProject(row) : null;
}

export async function getForMeeting(
  db: AppDb,
  meeting: { folderId: string | null; userId: string },
): Promise<Project | null> {
  if (!meeting.folderId) return null;
  return await getForUser(db, { id: meeting.folderId, userId: meeting.userId });
}

export interface ProjectInput {
  name?: string;
  about?: string | null;
  vocabulary?: string[];
  people?: string | null;
  match?: string[];
}

function columns(input: ProjectInput) {
  return {
    ...(input.name !== undefined ? { name: input.name.trim().slice(0, PROJECT_LIMITS.name) } : {}),
    ...(input.about !== undefined ? { about: input.about?.trim().slice(0, PROJECT_LIMITS.about) || null } : {}),
    ...(input.people !== undefined ? { people: input.people?.trim().slice(0, PROJECT_LIMITS.people) || null } : {}),
    ...(input.vocabulary !== undefined ? { vocabularyJson: JSON.stringify(cleanList(input.vocabulary)) } : {}),
    ...(input.match !== undefined
      ? { matchJson: JSON.stringify(cleanList(input.match, PROJECT_LIMITS.match)) }
      : {}),
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

export async function update(db: AppDb, args: { id: string; userId: string } & ProjectInput): Promise<boolean> {
  const { id, userId, ...input } = args;
  const result = await db
    .update(folders)
    .set({ ...columns(input), updatedAt: Date.now() })
    .where(and(eq(folders.id, id), eq(folders.userId, userId)))
    .returning({ id: folders.id });
  return result.length > 0;
}

/** Deletes the project; its recordings stay and simply lose the project. */
export async function remove(db: AppDb, args: { id: string; userId: string }): Promise<boolean> {
  const deleted = await db
    .delete(folders)
    .where(and(eq(folders.id, args.id), eq(folders.userId, args.userId)))
    .returning({ id: folders.id });
  if (deleted.length === 0) return false;
  await db
    .update(meetings)
    .set({ folderId: null })
    .where(and(eq(meetings.userId, args.userId), eq(meetings.folderId, args.id)));
  await db
    .update(captures)
    .set({ folderId: null })
    .where(and(eq(captures.userId, args.userId), eq(captures.folderId, args.id)));
  return true;
}

export async function ownsProject(db: AppDb, userId: string, projectId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: folders.id })
      .from(folders)
      .where(and(eq(folders.id, projectId), eq(folders.userId, userId)))
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
export async function vocabularySuggestions(db: AppDb, args: { id: string; userId: string }): Promise<string[]> {
  const project = await getForUser(db, args);
  if (!project) return [];
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
