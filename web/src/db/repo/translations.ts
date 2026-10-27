import { and, asc, eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { transcriptSegments, transcriptTranslations } from '../schema';

export interface LineToTranslate {
  id: string;
  text: string;
  language: string | null;
}

/** A meeting's lines, and the translations into `language` still matching each line's text. */
export async function linesWithTranslations(
  db: AppDb,
  args: { meetingId: string; language: string },
): Promise<{ lines: LineToTranslate[]; translated: Map<string, string> }> {
  const [lines, cached] = await db.batch([
    db
      .select({ id: transcriptSegments.id, text: transcriptSegments.text, language: transcriptSegments.language })
      .from(transcriptSegments)
      .where(eq(transcriptSegments.meetingId, args.meetingId))
      .orderBy(asc(transcriptSegments.startMs)),
    db
      .select({
        segmentId: transcriptTranslations.segmentId,
        sourceText: transcriptTranslations.sourceText,
        text: transcriptTranslations.text,
      })
      .from(transcriptTranslations)
      .where(
        and(
          eq(transcriptTranslations.meetingId, args.meetingId),
          eq(transcriptTranslations.language, args.language),
        ),
      ),
  ]);
  const source = new Map(lines.map((line) => [line.id, line.text]));
  const translated = new Map<string, string>();
  for (const row of cached) {
    if (source.get(row.segmentId) === row.sourceText) translated.set(row.segmentId, row.text);
  }
  return { lines, translated };
}

export async function saveTranslations(
  db: AppDb,
  args: {
    meetingId: string;
    language: string;
    entries: { segmentId: string; sourceText: string; text: string }[];
  },
) {
  const now = Date.now();
  const statements = args.entries.map((entry) =>
    db
      .insert(transcriptTranslations)
      .values({ ...entry, meetingId: args.meetingId, language: args.language, createdAt: now })
      .onConflictDoUpdate({
        target: [transcriptTranslations.segmentId, transcriptTranslations.language],
        set: { sourceText: entry.sourceText, text: entry.text, createdAt: now },
      }),
  );
  for (let i = 0; i < statements.length; i += 50) {
    const chunk = statements.slice(i, i + 50);
    if (chunk.length > 0) await db.batch(chunk as [typeof chunk[number], ...typeof chunk]);
  }
}
