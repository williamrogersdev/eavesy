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
  vision: 'claude-sonnet-4-6',
  embed: 'voyage-3',
} as const;
