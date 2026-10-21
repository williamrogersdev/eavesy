import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import type { AppDb } from '@/db/client';
import { dictations } from '@/db/schema';
import * as dictionary from '@/db/repo/dictionary';
import { learnCorrections, validCorrection, normalizeTerm } from '@/lib/dictionary/learning';
import { MAX_BULK_REPLACEMENTS } from '@/lib/dictionary/bulk';
import { isRecord } from '@/lib/json';
import type { ResolvedIngestActor } from './device-auth';

const feedback = z.object({
  original: z.string().min(1).max(12_000), corrected: z.string().min(1).max(12_000),
  dictationId: z.string().max(100).optional(),
});

/** Shared by browser and paired desktop; account always comes from authentication. */
export async function dictionaryRequest(request: Request, db: AppDb, actor: ResolvedIngestActor): Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  if (request.method === 'GET') return json({ entries: await dictionary.list(db, actor.userId) });
  let body: unknown;
  try {
    const reader = request.body?.getReader();
    if (!reader) return json({ error: 'invalid_json' }, 400);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 100_000) { await reader.cancel(); return json({ error: 'body_too_large' }, 413); }
      chunks.push(part.value);
    }
    const joined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
    body = JSON.parse(new TextDecoder().decode(joined));
  } catch { return json({ error: 'invalid_json' }, 400); }
  if (request.method === 'DELETE') {
    const parsed = z.object({ id: z.string().min(1).max(100) }).safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_request' }, 400);
    await dictionary.forget(db, actor.userId, parsed.data.id);
    return json({ ok: true });
  }
  if (request.method === 'PUT' && isRecord(body) && Array.isArray(body.entries)) {
    const parsed = z.object({ entries: z.array(z.object({ from: z.string().max(128), to: z.string().max(128) })).min(1).max(MAX_BULK_REPLACEMENTS) }).safeParse(body);
    if (!parsed.success) return json({ error: 'invalid_request' }, 400);
    const valid = parsed.data.entries.filter(entry => validCorrection(entry.from, entry.to));
    // remember() admits new words only while the account is under its 500-entry cap.
    const learned = valid.length ? await dictionary.remember(db, actor.userId, valid) : 0;
    return json({ learned, skipped: parsed.data.entries.length - valid.length, status: learned > 0 ? 'saved' : valid.length ? 'unchanged' : 'not_saved' });
  }
  if (request.method === 'PUT') {
    const parsed = z.object({ from: z.string(), to: z.string() }).safeParse(body);
    if (!parsed.success || !validCorrection(parsed.data.from, parsed.data.to)) return json({ error: 'invalid_correction' }, 400);
    const existing = await dictionary.list(db, actor.userId);
    if (existing.length >= 500 && !existing.some(e => e.sourceKey === normalizeTerm(parsed.data.from))) return json({ error: 'Dictionary is full. Forget an entry before adding another.' }, 400);
    const learned = await dictionary.remember(db, actor.userId, [parsed.data]);
    if (learned > 0) return json({ learned, status: 'saved' });
    const current = await dictionary.list(db, actor.userId);
    const unchanged = current.some(entry => entry.from === parsed.data.from && entry.to === parsed.data.to);
    return json({ learned: 0, status: unchanged ? 'unchanged' : 'not_saved',
      message: unchanged ? 'This correction is already saved.' : 'The correction could not be saved. Refresh the dictionary and try again.' });
  }
  const parsed = feedback.safeParse(body);
  if (!parsed.success) return json({ error: 'invalid_request' }, 400);
  const { original, corrected, dictationId } = parsed.data;
  if (dictationId) {
    const item = (await db.select().from(dictations).where(and(
      eq(dictations.id, dictationId), eq(dictations.userId, actor.userId), isNull(dictations.deletedAt),
    )).limit(1))[0];
    if (!item) return json({ error: 'not_found' }, 404);
    const current = item.cleanedText ?? item.transcript;
    if (current !== original && current !== corrected) return json({ error: 'transcript_changed' }, 409);
    if (current !== corrected) await db.update(dictations).set({ cleanedText: corrected }).where(and(eq(dictations.id, dictationId), eq(dictations.userId, actor.userId)));
  } else if (!actor.deviceId) {
    // Unreferenced passages are accepted only from a paired Mac's capture observer.
    return json({ error: 'dictation_required' }, 400);
  }
  const corrections = learnCorrections(original, corrected);
  const words = await dictionary.rememberCorrections(db, actor.userId, corrections);
  return json({ learned: words.length, words });
}
