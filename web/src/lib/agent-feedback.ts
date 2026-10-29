import { PROMPT_LIMITS } from './prompts';

/**
 * Feedback agents send over MCP about what Eavesy gave them: a typo, something
 * that doesn't make sense, or a saved prompt that could be better. Shared by
 * the MCP Worker, the API and Settings.
 */

export const FEEDBACK_KINDS = ['typo', 'unclear', 'poor_prompt', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_TARGETS = ['prompt', 'meeting', 'dictation', 'capture'] as const;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

export const FEEDBACK_LIMITS = {
  excerpt: 500,
  explanation: 1_000,
  rewrite: PROMPT_LIMITS.body,
  /** Reports one connection may send in an hour. */
  perConnectionPerHour: 20,
  /** Open reports kept per account, and per prompt or item; past these, new ones are refused. */
  openPerUser: 200,
  openPerTarget: 20,
} as const;

export interface AgentFeedback {
  id: string;
  /** The connection's name, like "Claude Code". */
  source: string;
  mcpTokenId: string;
  kind: FeedbackKind;
  targetType: FeedbackTarget;
  targetId: string;
  targetLabel: string;
  /** The prompt's `updatedAt` when reported. */
  targetVersion: number | null;
  excerpt: string | null;
  explanation: string;
  suggestedRewrite: string | null;
  createdAt: number;
}

const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

export function parseAgentFeedback(value: unknown): AgentFeedback | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  if (typeof v.id !== 'string' || typeof v.targetId !== 'string' || typeof v.explanation !== 'string') return null;
  if (!isOneOf(FEEDBACK_KINDS, v.kind) || !isOneOf(FEEDBACK_TARGETS, v.targetType)) return null;
  return {
    id: v.id,
    source: str(v.source) ?? 'An agent',
    mcpTokenId: str(v.mcpTokenId) ?? '',
    kind: v.kind,
    targetType: v.targetType,
    targetId: v.targetId,
    targetLabel: str(v.targetLabel) ?? '',
    targetVersion: typeof v.targetVersion === 'number' ? v.targetVersion : null,
    excerpt: str(v.excerpt),
    explanation: v.explanation,
    suggestedRewrite: str(v.suggestedRewrite),
    createdAt: typeof v.createdAt === 'number' ? v.createdAt : 0,
  };
}

/** How many different connections sent these: "N agents flagged this". */
export function distinctAgents(items: readonly AgentFeedback[]): number {
  return new Set(items.map((item) => item.mcpTokenId || item.source)).size;
}

export const FEEDBACK_KIND_LABELS: Record<FeedbackKind, string> = {
  typo: 'Typo',
  unclear: 'Doesn’t make sense',
  poor_prompt: 'Could be better',
  other: 'Note',
};

/** Text folded for comparing reports: case and runs of whitespace don't make a new one. */
export function normalizeForDedupe(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
