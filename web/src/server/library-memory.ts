import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { AppDb } from '@/db/client';
import { meetings, transcriptSegments } from '@/db/schema';
import { embedTexts, type WorkersAiRunner } from '@/lib/ai/embed';
import { answerLibrary, type LibraryAnswer, type LibrarySource } from '@/lib/ai/library-answer';
const STOP = new Set(['what', 'when', 'where', 'which', 'with', 'this', 'that', 'have', 'were', 'does', 'about', 'from', 'they', 'their', 'there', 'would', 'could', 'should', 'meeting', 'meetings']);
export function queryTerms(question: string): string[] {
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(t => !STOP.has(t)).slice(0, 8);
}
export async function librarySources(db: AppDb, userId: string, question: string, opts: { ai?: WorkersAiRunner; vectorize?: VectorizeIndex } = {}): Promise<LibrarySource[]> {
  const terms = queryTerms(question);
  const semantic: string[] = [];
  if (opts.ai && opts.vectorize) {
    const [vector] = await embedTexts(opts.ai, [question]);
    const matches = await opts.vectorize.query(vector, { topK: 30, filter: { userId, sourceType: 'meeting' }, returnMetadata: 'all' });
    for (const match of matches.matches) if (typeof match.metadata?.sourceId === 'string') semantic.push(match.metadata.sourceId);
  }
  // Hydrate the current transcript with an owner and deletion check. Vector
  // payloads and old summary text never become authoritative meeting evidence.
  const rows = await db.select({ id: transcriptSegments.id, meetingId: meetings.id, title: meetings.title, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs, text: transcriptSegments.text })
    .from(transcriptSegments).innerJoin(meetings, eq(meetings.id, transcriptSegments.meetingId))
    .where(and(eq(meetings.userId, userId), isNull(meetings.deletedAt), eq(meetings.status, 'complete'),
      (terms.length || semantic.length) ? or(...terms.map(term => like(transcriptSegments.text, `%${term}%`)), ...(semantic.length ? [inArray(meetings.id, semantic)] : [])) : undefined))
    .orderBy(desc(meetings.startedAt), transcriptSegments.startMs).limit(500);
  return rows.map(row => ({ row, score: terms.reduce((n, term) => n + (row.text.toLowerCase().includes(term) ? 3 : 0), semantic.includes(row.meetingId) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score).slice(0, 24).map(({ row }) => ({ ...row, text: row.text.slice(0, 1200) }));
}

export async function askLibrary(db: AppDb, userId: string, question: string, opts: { ai: WorkersAiRunner; vectorize?: VectorizeIndex }): Promise<LibraryAnswer> {
  const sources = await librarySources(db, userId, question, opts);
  const answer = await answerLibrary(opts.ai, question, sources);
  if (!answer.claims.length) return answer;
  // Sources can be edited or deleted while inference runs. Reject the entire
  // answer if any cited source changed, instead of displaying stale evidence.
  const ids = [...new Set(answer.claims.flatMap(c => c.citations.map(s => s.id)))];
  const current = await db.select({ id: transcriptSegments.id, text: transcriptSegments.text, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs, meetingId: meetings.id })
    .from(transcriptSegments).innerJoin(meetings, eq(meetings.id, transcriptSegments.meetingId))
    .where(and(eq(meetings.userId, userId), isNull(meetings.deletedAt), eq(meetings.status, 'complete'), inArray(transcriptSegments.id, ids)));
  const latest = new Map(current.map(s => [s.id, s]));
  for (const citation of answer.claims.flatMap(c => c.citations)) {
    const source = latest.get(citation.id);
    if (!source || source.meetingId !== citation.meetingId || source.startMs !== citation.startMs || source.endMs !== citation.endMs || source.text.slice(0, 1200) !== citation.text) return { abstained: true, claims: [] };
  }
  return answer;
}
