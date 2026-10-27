import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { personalDictionary } from '../schema';
import { pid } from '../ids';
import { isConfirmed, isLearnableSpelling, normalizeTerm, validCorrection, type LearnedCorrection } from '@/lib/dictionary/learning';

export async function list(db: AppDb, userId: string) {
  return db.select().from(personalDictionary).where(eq(personalDictionary.userId, userId))
    .orderBy(desc(personalDictionary.updatedAt)).limit(500);
}

/**
 * The same fix arriving again this soon is a retry of one edit, not a second sighting.
 * Only sightings and edits made by hand write a row, so `updatedAt` is the last sighting.
 */
const RETRY_MS = 30_000;

/** Entries trusted enough to steer transcription. A fix seen once is only a suggestion. */
export async function listForTranscription(db: AppDb, userId: string) {
  return (await list(db, userId)).filter(e => e.origin === 'manual' || (isConfirmed(e) && isLearnableSpelling(e.from, e.to)));
}

export type DictionaryOrigin = 'manual' | 'learned';

export async function remember(db: AppDb, userId: string, corrections: LearnedCorrection[], origin: DictionaryOrigin) {
  return (await rememberCorrections(db, userId, corrections, origin)).length;
}

/**
 * Saves corrections and returns the ones that were admitted, so a client can say
 * which words it learned. `pending` marks a learned fix still waiting for a second
 * sighting. Learning a -> b drops a learned b -> a: the user has changed their mind.
 */
export async function rememberCorrections(db: AppDb, userId: string, corrections: LearnedCorrection[], origin: DictionaryOrigin): Promise<(LearnedCorrection & { pending: boolean })[]> {
  const existing = await list(db, userId);
  const keys = new Set(existing.map(e => e.sourceKey));
  const now = Date.now();
  // A hand-made entry repeated is unchanged, and so is a learned one retried at once. A learned
  // one made again later counts as another sighting; keeping a suggestion makes it the user's.
  const unchanged = new Set(existing.filter(e => e.origin === 'manual' || (origin === 'learned' && e.updatedAt >= now - RETRY_MS))
    .map(e => JSON.stringify([e.from, e.to])));
  const accepted = corrections.filter(c => validCorrection(c.from, c.to) && !unchanged.has(JSON.stringify([c.from, c.to]))).filter(c => {
    const key = normalizeTerm(c.from);
    if (keys.has(key)) return true;
    if (keys.size >= 500) return false;
    keys.add(key); return true;
  });
  if (!accepted.length) return [];
  // A fix to a different word restarts the count: the user hasn't settled on one spelling yet.
  const sighting = origin === 'learned'
    ? (c: LearnedCorrection) => sql`CASE WHEN ${personalDictionary.to} = ${c.to} THEN ${personalDictionary.seen} + 1 ELSE 1 END`
    : () => sql`${personalDictionary.seen}`;
  // Admission and the insert/upsert share one SQLite statement. Concurrent
  // devices cannot race past the account cap, but existing words remain editable.
  const writes = accepted.map(c => db.insert(personalDictionary).select(sql`
    SELECT ${pid('word')}, ${userId}, ${normalizeTerm(c.from)}, ${c.from}, ${c.to}, ${origin}, 1, ${now}, ${now}
    WHERE (SELECT count(*) FROM personal_dictionary WHERE user_id = ${userId}) < 500
       OR EXISTS (SELECT 1 FROM personal_dictionary WHERE user_id = ${userId} AND source_key = ${normalizeTerm(c.from)})
  `).onConflictDoUpdate({ target: [personalDictionary.userId, personalDictionary.sourceKey],
    // A word the user added by hand stays theirs, whatever edit touches it later.
    set: { from: c.from, to: c.to, seen: sighting(c), origin: sql`CASE WHEN ${personalDictionary.origin} = 'manual' THEN 'manual' ELSE ${origin} END`, updatedAt: now } })
    .returning({ id: personalDictionary.id, origin: personalDictionary.origin, seen: personalDictionary.seen }));
  const reversals = accepted.map(c => db.delete(personalDictionary).where(and(
    eq(personalDictionary.userId, userId), eq(personalDictionary.sourceKey, normalizeTerm(c.to)),
    sql`lower(${personalDictionary.to}) = ${normalizeTerm(c.from)}`,
    sql`coalesce(${personalDictionary.origin}, '') <> 'manual'`,
    // Only once the new direction was admitted, so a full dictionary never loses the old one for nothing.
    sql`EXISTS (SELECT 1 FROM personal_dictionary WHERE user_id = ${userId} AND source_key = ${normalizeTerm(c.from)} AND to_text = ${c.to})`,
  )));
  const results = await db.batch([...writes, ...reversals] as [typeof writes[number], ...typeof writes[number][]]);
  // db.batch returns one result per statement, in order: the writes, then the reversals.
  const rows = results.slice(0, writes.length) as { origin: string | null; seen: number }[][];
  return accepted.flatMap(({ from, to }, index) => {
    const row = rows[index][0];
    return row ? [{ from, to, pending: !isConfirmed(row) }] : [];
  });
}

export async function forget(db: AppDb, userId: string, id: string) {
  await db.delete(personalDictionary).where(and(eq(personalDictionary.userId, userId), eq(personalDictionary.id, id)));
}
