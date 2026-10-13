import { OPENROUTER_MODELS } from '@/lib/providers/openrouter-chat';
import { resolveModelPlan, type RouterUser } from '@/lib/providers/router';
import { anthropicVisionEngine } from './anthropic-vision';
import { openRouterVisionEngine } from './openrouter-vision';
import type { VisionEngine, VisionMediaType, VisualTextResult } from './types';

export type VisionEngineKey = 'anthropic' | 'openrouter';

export function getVisionEngine(key: VisionEngineKey): VisionEngine {
  switch (key) {
    case 'anthropic':
      return anthropicVisionEngine;
    case 'openrouter':
      return openRouterVisionEngine;
  }
}

export function isSupportedImageType(contentType: string): contentType is VisionMediaType {
  return (
    contentType === 'image/png' ||
    contentType === 'image/jpeg' ||
    contentType === 'image/webp'
  );
}

export async function extractVisualText(opts: {
  image: Uint8Array;
  mediaType: VisionMediaType;
  user?: RouterUser | null;
}): Promise<VisualTextResult> {
  const plan = resolveModelPlan(opts.user);

  if (plan.openRouter) {
    return getVisionEngine('openrouter').extract({
      image: opts.image,
      mediaType: opts.mediaType,
      apiKey: plan.openRouter.apiKey,
      model: OPENROUTER_MODELS.vision,
    });
  }

  return getVisionEngine('anthropic').extract({
    image: opts.image,
    mediaType: opts.mediaType,
    apiKey: plan.vision.apiKey,
    model: plan.vision.model,
  });
}

export type { VisionEngine, VisionMediaType, VisualTextResult } from './types';
