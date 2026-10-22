import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { personalDictionary } from '../schema';
import { pid } from '../ids';
import { isLearnableSpelling, normalizeTerm, validCorrection, type LearnedCorrection } from '@/lib/dictionary/learning';

export async function list(db: AppDb, userId: string) {
  return db.select().from(personalDictionary).where(eq(personalDictionary.userId, userId))
    .orderBy(desc(personalDictionary.updatedAt)).limit(500);
}

/** Entries trusted enough to steer transcription. Legacy rows pass only if they look like real spellings. */
export async function listForTranscription(db: AppDb, userId: string) {
  return (await list(db, userId)).filter(e => e.origin === 'manual' || isLearnableSpelling(e.from, e.to));
}

export type DictionaryOrigin = 'manual' | 'learned';

export async function remember(db: AppDb, userId: string, corrections: LearnedCorrection[], origin: DictionaryOrigin) {
  return (await rememberCorrections(db, userId, corrections, origin)).length;
}

/** Saves corrections and returns the ones that were admitted, so a client can say which words it learned. */
export async function rememberCorrections(db: AppDb, userId: string, corrections: LearnedCorrection[], origin: DictionaryOrigin): Promise<LearnedCorrection[]> {
  const existing = await list(db, userId);
  const keys = new Set(existing.map(e => e.sourceKey));
  const unchanged = new Set(existing.map(e => JSON.stringify([e.from, e.to])));
  const accepted = corrections.filter(c => validCorrection(c.from, c.to) && !unchanged.has(JSON.stringify([c.from, c.to]))).filter(c => {
    const key = normalizeTerm(c.from);
    if (keys.has(key)) return true;
    if (keys.size >= 500) return false;
    keys.add(key); return true;
  });
  if (!accepted.length) return [];
  const now = Date.now();
  // Admission and the insert/upsert share one SQLite statement. Concurrent
  // devices cannot race past the account cap, but existing words remain editable.
  const writes = accepted.map(c => db.insert(personalDictionary).select(sql`
    SELECT ${pid('word')}, ${userId}, ${normalizeTerm(c.from)}, ${c.from}, ${c.to}, ${origin}, ${now}, ${now}
    WHERE (SELECT count(*) FROM personal_dictionary WHERE user_id = ${userId}) < 500
       OR EXISTS (SELECT 1 FROM personal_dictionary WHERE user_id = ${userId} AND source_key = ${normalizeTerm(c.from)})
  `).onConflictDoUpdate({ target: [personalDictionary.userId, personalDictionary.sourceKey],
    // A word the user added by hand stays theirs, whatever edit touches it later.
    set: { from: c.from, to: c.to, origin: sql`CASE WHEN ${personalDictionary.origin} = 'manual' THEN 'manual' ELSE ${origin} END`, updatedAt: now } }).returning({ id: personalDictionary.id }));
  const rows = await db.batch(writes as [typeof writes[number], ...typeof writes[number][]]);
  // Admitted upserts; exact repeats observed before the batch are skipped.
  // db.batch returns one result per statement, in order, so rows[i] is accepted[i].
  return accepted.filter((_, index) => rows[index].length > 0).map(({ from, to }) => ({ from, to }));
}

export async function forget(db: AppDb, userId: string, id: string) {
  await db.delete(personalDictionary).where(and(eq(personalDictionary.userId, userId), eq(personalDictionary.id, id)));
}
