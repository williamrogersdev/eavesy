import type { EngineKey } from '@/lib/transcription';
import { MODELS } from '@/lib/ai/client';

export type Billing = 'platform' | 'user';

export interface RouterUser {
  byoAnthropicKey?: string | null;
  byoOpenRouterKey?: string | null;
  defaultTranscriptionEngine?: EngineKey;
  defaultLanguage?: string | null;
}

export interface TranscriptionPlan {
  engine: EngineKey;
  billedTo: Billing;
}

export interface VisionPlan {
  provider: 'anthropic';
  model: string;
  apiKey?: string;
  billedTo: Billing;
}

export interface SummaryPlan {
  provider: 'anthropic';
  model: string;
  apiKey?: string;
  billedTo: Billing;
}

export interface OpenRouterConnection {
  apiKey: string;
}

export interface ModelPlan {
  transcription: TranscriptionPlan;
  vision: VisionPlan;
  summary: SummaryPlan;
  openRouter: OpenRouterConnection | null;
  language: string;
}

const DEFAULT_LANGUAGE = 'en';
const DEFAULT_ENGINE: EngineKey = 'whisper';

function trimmed(v: string | null | undefined): string | undefined {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : undefined;
}

export function resolveModelPlan(user?: RouterUser | null): ModelPlan {
  const anthropicKey = trimmed(user?.byoAnthropicKey);
  const openRouterKey = trimmed(user?.byoOpenRouterKey);
  const transcription: TranscriptionPlan = { engine: DEFAULT_ENGINE, billedTo: 'platform' };

  const vision: VisionPlan = {
    provider: 'anthropic',
    model: MODELS.vision,
    apiKey: anthropicKey,
    billedTo: anthropicKey ? 'user' : 'platform',
  };

  const summary: SummaryPlan = {
    provider: 'anthropic',
    model: MODELS.summary,
    apiKey: anthropicKey,
    billedTo: anthropicKey ? 'user' : 'platform',
  };

  return {
    transcription,
    vision,
    summary,
    openRouter: openRouterKey ? { apiKey: openRouterKey } : null,
    language: trimmed(user?.defaultLanguage) ?? DEFAULT_LANGUAGE,
  };
}
