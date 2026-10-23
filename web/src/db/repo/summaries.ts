import { eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { encode, decode, type ActionItem } from '../codec';
import { summaries } from '../schema';
import type { MeetingSummary } from '@/lib/ai/summarize';

/**
 * The brief a model produced for a meeting, written the same way wherever it
 * came from (the whole-file path, a regenerate). The pipeline's rolling and
 * final writes live in `server/processing/summarize.ts` because they carry
 * conditions of their own (a rolling write must not overtake a final one; an
 * import's write is refused once the import is cancelled).
 *
 * One row per meeting: a second write replaces the first and clears any
 * user edit. `templateId` records the brief format or custom template the
 * brief was made with, so the picker can start from it next time.
 */
export async function upsertSummary(
  db: AppDb,
  args: {
    meetingId: string;
    summary: Pick<MeetingSummary, 'tldr' | 'decisions' | 'actionItems' | 'followUps' | 'openQuestions' | 'topics' | 'mentions'>;
    generatedByModel: string;
    templateId?: string | null;
    generatedAt?: number;
  },
): Promise<void> {
  const values = {
    tldr: args.summary.tldr,
    decisionsJson: encode(args.summary.decisions),
    actionItemsJson: encode(args.summary.actionItems),
    followUpsJson: encode(args.summary.followUps),
    openQuestionsJson: encode(args.summary.openQuestions),
    topicsJson: encode(args.summary.topics),
    mentionsJson: encode(args.summary.mentions),
    generatedByModel: args.generatedByModel,
    templateId: args.templateId ?? null,
    generatedAt: args.generatedAt ?? Date.now(),
    userEditedAt: null,
  };
  await db
    .insert(summaries)
    .values({ id: `summary_${args.meetingId}`, meetingId: args.meetingId, ...values })
    .onConflictDoUpdate({ target: summaries.meetingId, set: values });
}

export async function toggleActionItem(
  db: AppDb,
  args: { summaryId: string; index: number; completed: boolean },
) {
  const rows = await db.select().from(summaries).where(eq(summaries.id, args.summaryId)).limit(1);
  const row = rows[0];
  if (!row) return;
  const items = decode<ActionItem[]>(row.actionItemsJson, []);
  if (!items[args.index]) return;
  items[args.index] = { ...items[args.index], completed: args.completed };
  await db
    .update(summaries)
    .set({ actionItemsJson: encode(items), userEditedAt: Date.now() })
    .where(eq(summaries.id, args.summaryId));
}

export async function getForMeeting(db: AppDb, meetingId: string) {
  const rows = await db.select().from(summaries).where(eq(summaries.meetingId, meetingId)).limit(1);
  return rows[0] ?? null;
}
