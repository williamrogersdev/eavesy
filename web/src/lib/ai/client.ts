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
  liveExtract: 'claude-haiku-4-5-20251001',
  vision: 'claude-sonnet-4-6',
  embed: 'voyage-3',
} as const;
