import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { snippets } from '../schema';
import { pid } from '../ids';
import { MAX_SNIPPETS, triggerKey, type SnippetField } from '@/lib/snippets';

export type SnippetRow = typeof snippets.$inferSelect;

export async function list(db: AppDb, userId: string): Promise<SnippetRow[]> {
  return db.select().from(snippets).where(eq(snippets.userId, userId))
    .orderBy(desc(snippets.updatedAt)).limit(MAX_SNIPPETS);
}

export type SaveSnippet = { id?: string; trigger: string; text: string; field: SnippetField | null };
export type SaveOutcome = 'saved' | 'full' | 'taken' | 'not_found';

/**
 * Adds a snippet, or changes the one `id` names. A trigger already used by
 * another snippet is `taken`; a new one past the cap is `full`. Only one
 * snippet fills each field, so tagging one takes the tag off any other.
 */
export async function save(db: AppDb, userId: string, input: SaveSnippet): Promise<SaveOutcome> {
  const key = triggerKey(input.trigger);
  const trigger = input.trigger.trim().split(/\s+/).join(' ');
  const now = Date.now();
  const existing = await list(db, userId);
  const holder = existing.find((row) => row.triggerKey === key);
  if (holder && holder.id !== input.id) return 'taken';
  if (input.id && !existing.some((row) => row.id === input.id)) return 'not_found';
  const id = input.id ?? pid('snip');
  // Runs after the write, and only once the snippet is there, so a refused insert takes no tag away.
  const untag = input.field
    ? [db.update(snippets).set({ field: null, updatedAt: now }).where(and(
      eq(snippets.userId, userId), eq(snippets.field, input.field), sql`${snippets.id} <> ${id}`,
      sql`EXISTS (SELECT 1 FROM snippets WHERE id = ${id} AND user_id = ${userId})`,
    ))]
    : [];
  if (input.id) {
    const update = db.update(snippets).set({ trigger, triggerKey: key, text: input.text, field: input.field, updatedAt: now })
      .where(and(eq(snippets.userId, userId), eq(snippets.id, id)));
    await db.batch([update, ...untag]);
    return 'saved';
  }
  // The cap is checked inside the insert, so two devices can't race past it.
  const insert = db.insert(snippets).select(sql`
    SELECT ${id}, ${userId}, ${key}, ${trigger}, ${input.text}, ${input.field}, ${now}, ${now}
    WHERE (SELECT count(*) FROM snippets WHERE user_id = ${userId}) < ${MAX_SNIPPETS}
  `).onConflictDoNothing().returning({ id: snippets.id });
  const [inserted] = await db.batch([insert, ...untag]);
  if ((inserted as { id: string }[]).length) return 'saved';
  // Nothing went in: the phrase was taken a moment ago, or the list is full.
  return (await list(db, userId)).some((row) => row.triggerKey === key) ? 'taken' : 'full';
}

export async function remove(db: AppDb, userId: string, id: string) {
  await db.delete(snippets).where(and(eq(snippets.userId, userId), eq(snippets.id, id)));
}
