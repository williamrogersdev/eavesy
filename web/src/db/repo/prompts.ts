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
/** Another request kept taking the slug this one picked. */
export class SlugConflict extends Error {}

const SLUG_ATTEMPTS = 4;

/** D1 surfaces a unique-index violation as "UNIQUE constraint failed", sometimes on the cause. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes('UNIQUE constraint failed')) return true;
  }
  return false;
}

/**
 * Picks a free slug and writes it, picking again when a concurrent request
 * took that slug in between: the unique index has the last word.
 */
async function withFreeSlug<T>(db: AppDb, userId: string, name: string, except: string | undefined, write: (slug: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt++) {
    try { return await write(freeSlug(promptSlug(name), await takenSlugs(db, userId, except))); }
    catch (error) { if (!isUniqueViolation(error)) throw error; }
  }
  throw new SlugConflict('slug_conflict');
}

export async function create(db: AppDb, userId: string, fields: { name: string; body: string }): Promise<SavedPrompt> {
  return withFreeSlug(db, userId, fields.name, undefined, async (slug) => {
    const now = Date.now();
    // The limit check and the insert are one statement, so concurrent creates can't pass it together.
    const rows = await db.insert(savedPrompts).select(sql`
      SELECT ${pid('prm')}, ${userId}, ${fields.name}, ${slug}, ${fields.body}, 0, NULL, ${now}, ${now}
      WHERE (SELECT count(*) FROM saved_prompts WHERE user_id = ${userId}) < ${PROMPT_LIMITS.count}
    `).returning();
    if (!rows[0]) throw new TooManyPrompts('too_many_prompts');
    return toSavedPrompt(rows[0]);
  });
}

/** Renaming a prompt renames its slash command too. Null when it isn't this account's. */
export async function update(db: AppDb, userId: string, id: string, fields: { name?: string; body?: string }): Promise<SavedPrompt | null> {
  const write = async (slug?: string) => {
    const patch: Partial<typeof savedPrompts.$inferInsert> = { updatedAt: Date.now() };
    if (fields.body !== undefined) patch.body = fields.body;
    if (fields.name !== undefined) { patch.name = fields.name; patch.slug = slug; }
    const row = (await db.update(savedPrompts).set(patch)
      .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId))).returning())[0];
    return row ? toSavedPrompt(row) : null;
  };
  return fields.name === undefined ? write() : withFreeSlug(db, userId, fields.name, id, write);
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
