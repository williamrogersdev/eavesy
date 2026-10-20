import { and, desc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { personalDictionary } from '../schema';
import { pid } from '../ids';
import { normalizeTerm, validCorrection, type LearnedCorrection } from '@/lib/dictionary/learning';

export async function list(db: AppDb, userId: string) {
  return db.select().from(personalDictionary).where(eq(personalDictionary.userId, userId))
    .orderBy(desc(personalDictionary.updatedAt)).limit(500);
}

export async function remember(db: AppDb, userId: string, corrections: LearnedCorrection[]) {
  const existing = await list(db, userId);
  const keys = new Set(existing.map(e => e.sourceKey));
  const unchanged = new Set(existing.map(e => JSON.stringify([e.from, e.to])));
  const accepted = corrections.filter(c => validCorrection(c.from, c.to) && !unchanged.has(JSON.stringify([c.from, c.to]))).filter(c => {
    const key = normalizeTerm(c.from);
    if (keys.has(key)) return true;
    if (keys.size >= 500) return false;
    keys.add(key); return true;
  });
  if (!accepted.length) return 0;
  const now = Date.now();
  const writes = accepted.map(c => db.insert(personalDictionary).values({
    id: pid('word'), userId, sourceKey: normalizeTerm(c.from), from: c.from, to: c.to, createdAt: now, updatedAt: now,
  }).onConflictDoUpdate({ target: [personalDictionary.userId, personalDictionary.sourceKey],
    set: { from: c.from, to: c.to, updatedAt: now } }));
  await db.batch(writes as [typeof writes[number], ...typeof writes[number][]]);
  return accepted.length;
}

export async function forget(db: AppDb, userId: string, id: string) {
  await db.delete(personalDictionary).where(and(eq(personalDictionary.userId, userId), eq(personalDictionary.id, id)));
}
