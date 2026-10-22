import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { savedPrompts } from '../schema';
import { pid } from '../ids';
import { freeSlug, PROMPT_LIMITS, promptSlug, type SavedPrompt } from '@/lib/prompts';

type Row = typeof savedPrompts.$inferSelect;

export function toSavedPrompt(row: Row): SavedPrompt {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    body: row.body,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt,
    updatedAt: row.updatedAt,
  };
}

export async function list(db: AppDb, userId: string): Promise<SavedPrompt[]> {
  const rows = await db.select().from(savedPrompts).where(eq(savedPrompts.userId, userId))
    .orderBy(asc(savedPrompts.name)).limit(PROMPT_LIMITS.count);
  return rows.map(toSavedPrompt);
}

export async function getBySlug(db: AppDb, userId: string, slug: string): Promise<SavedPrompt | null> {
  const row = (await db.select().from(savedPrompts)
    .where(and(eq(savedPrompts.userId, userId), eq(savedPrompts.slug, slug))).limit(1))[0];
  return row ? toSavedPrompt(row) : null;
}

async function takenSlugs(db: AppDb, userId: string, except?: string): Promise<Set<string>> {
  const rows = await db.select({ id: savedPrompts.id, slug: savedPrompts.slug }).from(savedPrompts)
    .where(eq(savedPrompts.userId, userId));
  return new Set(rows.filter((row) => row.id !== except).map((row) => row.slug));
}

export class TooManyPrompts extends Error {}

export async function create(db: AppDb, userId: string, fields: { name: string; body: string }): Promise<SavedPrompt> {
  const taken = await takenSlugs(db, userId);
  if (taken.size >= PROMPT_LIMITS.count) throw new TooManyPrompts('too_many_prompts');
  const now = Date.now();
  const row = (await db.insert(savedPrompts).values({
    id: pid('prm'),
    userId,
    name: fields.name,
    slug: freeSlug(promptSlug(fields.name), taken),
    body: fields.body,
    createdAt: now,
    updatedAt: now,
  }).returning())[0];
  return toSavedPrompt(row);
}

/** Renaming a prompt renames its slash command too. Null when it isn't this account's. */
export async function update(db: AppDb, userId: string, id: string, fields: { name?: string; body?: string }): Promise<SavedPrompt | null> {
  const patch: Partial<typeof savedPrompts.$inferInsert> = { updatedAt: Date.now() };
  if (fields.body !== undefined) patch.body = fields.body;
  if (fields.name !== undefined) {
    patch.name = fields.name;
    patch.slug = freeSlug(promptSlug(fields.name), await takenSlugs(db, userId, id));
  }
  const row = (await db.update(savedPrompts).set(patch)
    .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId))).returning())[0];
  return row ? toSavedPrompt(row) : null;
}

/** Counts a paste or slash-command run, so the most used come first. */
export async function markUsed(db: AppDb, userId: string, id: string): Promise<SavedPrompt | null> {
  const row = (await db.update(savedPrompts)
    .set({ useCount: sql`${savedPrompts.useCount} + 1`, lastUsedAt: Date.now() })
    .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId))).returning())[0];
  return row ? toSavedPrompt(row) : null;
}

export async function remove(db: AppDb, userId: string, id: string): Promise<void> {
  await db.delete(savedPrompts).where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId)));
}
