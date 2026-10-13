import { imageDataUrl, openRouterChat } from '@/lib/providers/openrouter-chat';
import { VISION_OCR_SYSTEM_PROMPT } from './prompt';
import type { VisionEngine, VisionMediaType, VisualTextResult } from './types';

export const openRouterVisionEngine: VisionEngine = {
  async extract(opts: {
    image: Uint8Array;
    mediaType: VisionMediaType;
    apiKey?: string;
    model: string;
  }): Promise<VisualTextResult> {
    if (!opts.apiKey) {
      throw new Error('OpenRouter vision requires a connection key');
    }

    const text = (
      await openRouterChat({
        apiKey: opts.apiKey,
        model: opts.model,
        maxTokens: 2048,
        messages: [
          { role: 'system', content: VISION_OCR_SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: imageDataUrl(opts.mediaType, opts.image) } },
              { type: 'text', text: 'Extract the text and describe this screenshot.' },
            ],
          },
        ],
      })
    ).trim();

    return { text, model: opts.model, empty: text.length === 0 };
  },
};
