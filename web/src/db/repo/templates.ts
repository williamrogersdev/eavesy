import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { pid } from '../ids';
import { promptTemplates } from '../schema';

export type Template = typeof promptTemplates.$inferSelect;
export type AppliesTo = Template['appliesTo'];

/** Brief and dictation templates one account may keep. */
export const TEMPLATE_LIMIT = 200;

export class TooManyTemplates extends Error {}

export async function listForUser(db: AppDb, userId: string): Promise<Template[]> {
  return await db
    .select()
    .from(promptTemplates)
    .where(eq(promptTemplates.userId, userId))
    .orderBy(asc(promptTemplates.sortOrder))
    .limit(TEMPLATE_LIMIT);
}

export async function getForUser(db: AppDb, args: { id: string; userId: string }) {
  const rows = await db
    .select()
    .from(promptTemplates)
    .where(and(eq(promptTemplates.id, args.id), eq(promptTemplates.userId, args.userId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function create(
  db: AppDb,
  args: {
    userId: string;
    name: string;
    systemPrompt: string;
    description?: string;
    hotkey?: string;
    appliesTo: AppliesTo;
    isDefault?: boolean;
    sortOrder?: number;
  },
): Promise<string> {
  const id = pid('tpl');
  // The limit check and the insert are one statement, so concurrent creates can't pass it together.
  const rows = await db.insert(promptTemplates).select(sql`
    SELECT ${id}, ${args.userId}, ${args.name}, ${args.description ?? null}, ${args.hotkey ?? null},
      ${args.systemPrompt}, ${args.appliesTo}, ${args.isDefault ? 1 : 0}, ${args.sortOrder ?? 0}
    WHERE (SELECT count(*) FROM prompt_templates WHERE user_id = ${args.userId}) < ${TEMPLATE_LIMIT}
  `).returning({ id: promptTemplates.id });
  if (!rows[0]) throw new TooManyTemplates('too_many_templates');
  return id;
}

export async function update(
  db: AppDb,
  args: {
    id: string;
    userId: string;
    name?: string;
    systemPrompt?: string;
    description?: string | null;
    hotkey?: string | null;
    sortOrder?: number;
  },
) {
  const patch: Partial<typeof promptTemplates.$inferInsert> = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.systemPrompt !== undefined) patch.systemPrompt = args.systemPrompt;
  if (args.description !== undefined) patch.description = args.description;
  if (args.hotkey !== undefined) patch.hotkey = args.hotkey;
  if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;
  await db
    .update(promptTemplates)
    .set(patch)
    .where(and(eq(promptTemplates.id, args.id), eq(promptTemplates.userId, args.userId)));
}

export async function remove(db: AppDb, args: { id: string; userId: string }) {
  await db
    .delete(promptTemplates)
    .where(and(eq(promptTemplates.id, args.id), eq(promptTemplates.userId, args.userId)));
}

export async function seedDefaultsForUser(db: AppDb, userId: string) {
  await db.insert(promptTemplates).values([
    {
      id: pid('tpl'),
      userId,
      name: 'Slack message',
      systemPrompt:
        "You will receive a transcript of the user dictating a message they want to send on Slack. Rewrite it as a concise, friendly Slack message. Use bullet points when listing items. Keep it under 100 words. Don't add a sign-off.",
      appliesTo: 'dictation',
      sortOrder: 0,
      isDefault: true,
    },
    {
      id: pid('tpl'),
      userId,
      name: 'Claude prompt',
      systemPrompt:
        'Rewrite the dictated text as a clear, well-structured prompt for an AI assistant. Add structure where appropriate (numbered steps, constraints). Do not invent requirements.',
      appliesTo: 'dictation',
      sortOrder: 1,
      isDefault: false,
    },
    {
      id: pid('tpl'),
      userId,
      name: 'Sales call',
      systemPrompt:
        "You are summarizing a sales call. Include: prospect name and company, decision criteria, objections raised, next steps, blockers, and a 'who said what about budget' section. Don't invent figures.",
      appliesTo: 'meeting',
      sortOrder: 2,
      isDefault: false,
    },
  ]);
}
