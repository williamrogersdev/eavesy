import { eq } from 'drizzle-orm';
import type { AppDb } from '../client';
import { encode, decode, type ActionItem, type Decision, type Mention, type Sourced } from '../codec';
import { pid } from '../ids';
import { summaries } from '../schema';

export interface StructuredSummary {
  tldr: string;
  decisions: Decision[];
  actionItems: ActionItem[];
  followUps: Sourced[];
  openQuestions: Sourced[];
  topics: string[];
  mentions: Mention[];
}

export async function upsert(
  db: AppDb,
  args: {
    meetingId: string;
    summary: StructuredSummary;
    generatedByModel: string;
    templateId?: string;
  },
): Promise<string> {
  const existing = await db
    .select()
    .from(summaries)
    .where(eq(summaries.meetingId, args.meetingId))
    .limit(1);
  const now = Date.now();
  const payload = {
    tldr: args.summary.tldr,
    decisionsJson: encode(args.summary.decisions),
    actionItemsJson: encode(args.summary.actionItems),
    followUpsJson: encode(args.summary.followUps),
    openQuestionsJson: encode(args.summary.openQuestions),
    topicsJson: encode(args.summary.topics),
    mentionsJson: encode(args.summary.mentions),
    generatedByModel: args.generatedByModel,
    templateId: args.templateId,
    generatedAt: now,
    userEditedAt: null,
  };

  if (existing[0]) {
    await db.update(summaries).set(payload).where(eq(summaries.id, existing[0].id));
    return existing[0].id;
  }

  const id = pid('sum');
  await db.insert(summaries).values({ id, meetingId: args.meetingId, ...payload });
  return id;
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
