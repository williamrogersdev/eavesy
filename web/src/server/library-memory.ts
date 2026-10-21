import { and, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { VectorizeIndex } from '@cloudflare/workers-types';
import type { AppDb } from '@/db/client';
import { meetings, transcriptSegments } from '@/db/schema';
import { embedTexts, type WorkersAiRunner } from '@/lib/ai/embed';
import { answerLibrary, type LibraryAnswer, type LibrarySource } from '@/lib/ai/library-answer';
const STOP = new Set(['the', 'and', 'for', 'was', 'are', 'did', 'how', 'why', 'who', 'can', 'our', 'your', 'across', 'recording', 'recordings', 'titled', 'what', 'when', 'where', 'which', 'with', 'this', 'that', 'have', 'were', 'does', 'about', 'from', 'they', 'their', 'there', 'would', 'could', 'should', 'meeting', 'meetings']);
export function requestedRecordingTitle(question: string): string | undefined {
  return /\brecording\s+titled\s+["“]([^"”]+)["”]/iu.exec(question)?.[1].trim();
}
export function queryTerms(question: string): string[] {
  const title = requestedRecordingTitle(question);
  const detail = title ? question.replace(title, '') : question;
  return [...new Set(searchFold(detail).match(/[\p{L}\p{N}]{3,}/gu) ?? [])].filter(t => !STOP.has(t)).slice(0, 16);
}
// SQLite lower() only folds ASCII. Fold the non-ASCII case variants present
// in this bounded query explicitly, then let SQLite handle ASCII. This keeps
// case-insensitive accented/Cyrillic matching without scanning rows in JS.
function searchFold(text: string): string { return text.toLowerCase().replace(/\u0307/gu, ''); }
function folded(column: SQLWrapper, query: string): SQL {
  let expression = sql`lower(${column})`;
  const normalized = searchFold(query);
  if (normalized.includes('i')) {
    expression = sql`replace(replace(${expression}, ${'İ'}, ${'i'}), ${'i\u0307'}, ${'i'})`;
  }
  for (const char of new Set(normalized)) {
    const upper = char.toUpperCase();
    if (upper !== char && [...upper].length === 1 && upper.charCodeAt(0) > 127 && char.charCodeAt(0) > 127) expression = sql`replace(${expression}, ${upper}, ${char})`;
  }
  return expression;
}
const fields = { id: transcriptSegments.id, meetingId: meetings.id, title: meetings.title, startMs: transcriptSegments.startMs, endMs: transcriptSegments.endMs, text: transcriptSegments.text };
export async function librarySources(db: AppDb, userId: string, question: string, opts: { ai?: WorkersAiRunner; vectorize?: VectorizeIndex } = {}): Promise<LibrarySource[]> {
  const owner = and(eq(meetings.userId, userId), isNull(meetings.deletedAt), eq(meetings.status, 'complete'));
  const title = requestedRecordingTitle(question);
  if (title) {
    // Explicit source scope is authoritative: never answer from a different
    // recording simply because its embedding is similar. No AI call needed.
    const terms = queryTerms(question);
    const hits = terms.map(term => sql`CASE WHEN instr(${folded(transcriptSegments.text, term)}, ${term}) > 0 THEN 1 ELSE 0 END`);
    const score = hits.length ? sql`(${sql.join(hits, sql` + `)})` : sql`0`;
    const rows = await db.select(fields).from(transcriptSegments).innerJoin(meetings, eq(meetings.id, transcriptSegments.meetingId))
      .where(and(owner, sql`${folded(sql`trim(${meetings.title})`, title)} = ${searchFold(title)}`))
      .orderBy(desc(score), desc(meetings.startedAt), transcriptSegments.startMs).limit(257);
    return boundedSources(rows, 256);
  }
  const terms = queryTerms(question);
  const semantic: string[] = [];
  if (opts.ai && opts.vectorize) {
    const [vector] = await embedTexts(opts.ai, [question]);
    const matches = await opts.vectorize.query(vector, { topK: 30, filter: { userId, sourceType: 'meeting' }, returnMetadata: 'all' });
    for (const match of matches.matches) if (typeof match.metadata?.sourceId === 'string') semantic.push(match.metadata.sourceId);
  }
  if (!terms.length && !semantic.length) return [];
  const hits = terms.map(term => sql`instr(${folded(transcriptSegments.text, term)}, ${term}) > 0`);
  const lexical = hits.length ? sql`(${sql.join(hits.map(hit => sql`CASE WHEN ${hit} THEN 1 ELSE 0 END`), sql` + `)})` : sql`0`;
  const semanticScore = semantic.length ? sql`CASE WHEN ${inArray(meetings.id, semantic)} THEN 1 ELSE 0 END` : sql`0`;
  // Rank in SQL BEFORE limiting, so older relevant evidence cannot be crowded
  // out by recent segments matching common words. Hydrate only current rows.
  const rows = await db.select(fields).from(transcriptSegments).innerJoin(meetings, eq(meetings.id, transcriptSegments.meetingId))
    .where(and(owner, or(...hits, ...(semantic.length ? [inArray(meetings.id, semantic)] : []))))
    .orderBy(desc(sql`${lexical} * 3 + ${semanticScore}`), desc(meetings.startedAt), transcriptSegments.startMs).limit(240);
  // Diverse recordings first, then fill unused space with additional context.
  const counts = new Map<string, number>();
  const diverse = rows.filter(row => { const n = counts.get(row.meetingId) ?? 0; counts.set(row.meetingId, n + 1); return n < 6; });
  const ids = new Set(diverse.map(row => row.id));
  return boundedSources([...diverse, ...rows.filter(row => !ids.has(row.id))], 48);
}
function boundedSources(rows: LibrarySource[], limit: number): LibrarySource[] {
  let remaining = 24_000;
  const result: LibrarySource[] = [];
  // Deliberately report any omitted candidate, including normal top-K
  // selection: an abstention does not prove that the whole library lacks it.
  let truncated = rows.length > limit;
  for (const row of rows) {
    const text = row.text.slice(0, 1200);
    if (!text.trim()) continue;
    if (text.length > remaining) { truncated = true; continue; }
    if (row.text.length > 1200) truncated = true;
    result.push({ ...row, text }); remaining -= text.length;
    if (result.length === limit) break;
  }
  if (truncated && result.length) result[0] = { ...result[0], contextTruncated: true };
  return result;
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
