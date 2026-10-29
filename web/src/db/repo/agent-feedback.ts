import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDb } from '../client';
import { agentFeedback, savedPrompts } from '../schema';
import { pid } from '../ids';
import { FEEDBACK_LIMITS, normalizeForDedupe, type AgentFeedback, type FeedbackKind, type FeedbackTarget } from '@/lib/agent-feedback';
import type { SavedPrompt } from '@/lib/prompts';
import { sha256Hex } from '@/lib/sha256';
import { toSavedPrompt } from './prompts';

type Row = typeof agentFeedback.$inferSelect;

export function toAgentFeedback(row: Row): AgentFeedback {
  return {
    id: row.id,
    source: row.source,
    mcpTokenId: row.mcpTokenId,
    kind: row.kind,
    targetType: row.targetType,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    targetVersion: row.targetVersion,
    excerpt: row.excerpt,
    explanation: row.explanation,
    suggestedRewrite: row.suggestedRewrite,
    createdAt: row.createdAt,
  };
}

export interface NewFeedback {
  userId: string;
  mcpTokenId: string;
  source: string;
  kind: FeedbackKind;
  targetType: FeedbackTarget;
  targetId: string;
  targetLabel: string;
  targetVersion: number | null;
  excerpt: string | null;
  explanation: string;
  suggestedRewrite: string | null;
}

/** The same connection sending the same text about the same version of the same thing. */
export function dedupeKey(input: NewFeedback): Promise<string> {
  return sha256Hex(JSON.stringify([
    input.mcpTokenId,
    input.kind,
    input.targetType,
    input.targetId,
    input.targetVersion,
    normalizeForDedupe(input.excerpt),
    normalizeForDedupe(input.explanation),
    normalizeForDedupe(input.suggestedRewrite),
  ]));
}

export type RecordResult = { status: 'recorded'; id: string } | { status: 'duplicate' } | { status: 'full' };

/**
 * Keeps one report. The caps on open reports and the duplicate check are part
 * of the insert itself, so concurrent calls can't pass them together.
 */
export async function record(db: AppDb, input: NewFeedback, now = Date.now()): Promise<RecordResult> {
  const id = pid('afb', now);
  const key = await dedupeKey(input);
  const rows = await db.all<{ id: string }>(sql`
    INSERT INTO agent_feedback (id, user_id, mcp_token_id, source, kind, target_type, target_id, target_label, target_version,
      excerpt, explanation, suggested_rewrite, status, dedupe_key, created_at, resolved_at)
    SELECT ${id}, ${input.userId}, ${input.mcpTokenId}, ${input.source}, ${input.kind}, ${input.targetType}, ${input.targetId},
      ${input.targetLabel}, ${input.targetVersion}, ${input.excerpt}, ${input.explanation}, ${input.suggestedRewrite}, 'new', ${key}, ${now}, NULL
    WHERE (SELECT count(*) FROM agent_feedback WHERE user_id = ${input.userId} AND status = 'new') < ${FEEDBACK_LIMITS.openPerUser}
      AND (SELECT count(*) FROM agent_feedback WHERE user_id = ${input.userId} AND status = 'new'
        AND target_type = ${input.targetType} AND target_id = ${input.targetId}) < ${FEEDBACK_LIMITS.openPerTarget}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING
    RETURNING id
  `);
  if (rows[0]) return { status: 'recorded', id: rows[0].id };
  const existing = await db.select({ id: agentFeedback.id }).from(agentFeedback)
    .where(and(eq(agentFeedback.userId, input.userId), eq(agentFeedback.dedupeKey, key))).limit(1);
  return existing[0] ? { status: 'duplicate' } : { status: 'full' };
}

/** Reports waiting for the user, newest first. */
export async function listOpen(db: AppDb, userId: string): Promise<AgentFeedback[]> {
  const rows = await db.select().from(agentFeedback)
    .where(and(eq(agentFeedback.userId, userId), eq(agentFeedback.status, 'new')))
    .orderBy(desc(agentFeedback.createdAt))
    .limit(FEEDBACK_LIMITS.openPerUser);
  return rows.map(toAgentFeedback);
}

/** Marks the caller's own open reports dismissed. Returns how many changed. */
export async function dismiss(db: AppDb, userId: string, ids: string[], now = Date.now()): Promise<number> {
  if (!ids.length) return 0;
  const rows = await db.update(agentFeedback).set({ status: 'dismissed', resolvedAt: now })
    .where(and(eq(agentFeedback.userId, userId), inArray(agentFeedback.id, ids), eq(agentFeedback.status, 'new')))
    .returning({ id: agentFeedback.id });
  return rows.length;
}

export type ApplyResult = { status: 'applied'; prompt: SavedPrompt } | { status: 'conflict'; prompt: SavedPrompt } | { status: 'not_found' };

/**
 * Writes the text the user accepted into the prompt, only if it still reads
 * `expectedBody` (what the preview was made against), and marks those reports
 * on it applied. A prompt edited meanwhile is a conflict, never written over.
 */
export async function applyToPrompt(
  db: AppDb,
  userId: string,
  promptId: string,
  fields: { expectedBody: string; body: string; ids: string[] },
  now = Date.now(),
): Promise<ApplyResult> {
  const updated = (await db.update(savedPrompts).set({ body: fields.body, updatedAt: now })
    .where(and(eq(savedPrompts.id, promptId), eq(savedPrompts.userId, userId), eq(savedPrompts.body, fields.expectedBody)))
    .returning())[0];
  if (!updated) {
    const current = (await db.select().from(savedPrompts)
      .where(and(eq(savedPrompts.id, promptId), eq(savedPrompts.userId, userId))).limit(1))[0];
    return current ? { status: 'conflict', prompt: toSavedPrompt(current) } : { status: 'not_found' };
  }
  if (fields.ids.length) {
    await db.update(agentFeedback).set({ status: 'applied', resolvedAt: now })
      .where(and(
        eq(agentFeedback.userId, userId),
        inArray(agentFeedback.id, fields.ids),
        eq(agentFeedback.targetType, 'prompt'),
        eq(agentFeedback.targetId, promptId),
        eq(agentFeedback.status, 'new'),
      ));
  }
  return { status: 'applied', prompt: toSavedPrompt(updated) };
}

/** The open reports on one of the caller's prompts, for merging into one rewrite. */
export async function openForPrompt(db: AppDb, userId: string, promptId: string, ids?: string[]): Promise<AgentFeedback[]> {
  const rows = await db.select().from(agentFeedback)
    .where(and(
      eq(agentFeedback.userId, userId),
      eq(agentFeedback.targetType, 'prompt'),
      eq(agentFeedback.targetId, promptId),
      eq(agentFeedback.status, 'new'),
      ...(ids ? [inArray(agentFeedback.id, ids)] : []),
    ))
    .orderBy(desc(agentFeedback.createdAt))
    .limit(FEEDBACK_LIMITS.openPerTarget);
  return rows.map(toAgentFeedback);
}
