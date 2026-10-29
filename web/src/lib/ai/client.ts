import Anthropic from '@anthropic-ai/sdk';
import { requireServerEnv } from '@/lib/env';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: requireServerEnv('ANTHROPIC_API_KEY') });
  }
  return client;
}

export function anthropicForUser(userKey: string): Anthropic {
  return new Anthropic({ apiKey: userKey });
}

export const MODELS = {
  summary: 'claude-sonnet-4-6',
  /** Rolling notes while a meeting is live: frequent, short, latency-sensitive. */
  rollingNotes: 'claude-haiku-5-5',
  /** Cleans finished transcripts up for pasting into an agent: many short requests. */
  transcriptCleanup: 'claude-haiku-5-5',
  /** Transcript translation: many short lines, latency-sensitive. */
  translate: 'claude-haiku-5-5',
  /** Spoken summary and suggested reply when a Claude Code session stops: short, latency-sensitive. */
  agentReply: 'claude-haiku-5-5',
  /** Saved prompts suggested from the user's recent dictations, on request in Settings. */
  promptSuggestions: 'claude-haiku-5-5',
  /** Agents' feedback on a saved prompt merged into one proposed rewrite, on request in Settings. */
  promptFeedbackMerge: 'claude-haiku-5-5',
  /** Eavesy's conversation: tool use, short replies. */
  assistant: 'claude-sonnet-5-5',
  /** The second-model check on each tier 2 or 3 action (assistant.md C7). */
  assistantCheck: 'claude-haiku-5-5',
  vision: 'claude-sonnet-4-6',
  embed: 'voyage-3',
} as const;
