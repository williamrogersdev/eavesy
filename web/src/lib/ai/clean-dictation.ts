import { anthropic, MODELS } from './client';

export async function applyTemplate(raw: string, systemPrompt: string): Promise<string> {
  if (!raw.trim()) return '';
  const response = await anthropic().messages.create({
    model: MODELS.transcriptCleanup,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: raw }],
  });
  return response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
}
