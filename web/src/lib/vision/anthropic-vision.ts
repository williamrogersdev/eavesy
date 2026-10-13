import { anthropic, anthropicForUser } from '@/lib/ai/client';
import { VISION_OCR_SYSTEM_PROMPT } from './prompt';
import type { VisionEngine, VisionMediaType, VisualTextResult } from './types';

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export const anthropicVisionEngine: VisionEngine = {
  async extract(opts: {
    image: Uint8Array;
    mediaType: VisionMediaType;
    apiKey?: string;
    model: string;
  }): Promise<VisualTextResult> {
    const client = opts.apiKey ? anthropicForUser(opts.apiKey) : anthropic();

    const response = await client.messages.create({
      model: opts.model,
      max_tokens: 2048,
      system: VISION_OCR_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: opts.mediaType,
                data: toBase64(opts.image),
              },
            },
            { type: 'text', text: 'Extract the text and describe this screenshot.' },
          ],
        },
      ],
    });

    const text = response.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim();

    return { text, model: opts.model, empty: text.length === 0 };
  },
};
