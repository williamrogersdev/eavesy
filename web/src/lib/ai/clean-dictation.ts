import { anthropic, MODELS } from './client';

const SYSTEM_PROMPT = `Clean the user's spoken transcription into readable text.

Rules:
- Remove filler ("um", "uh", "you know").
- Fix punctuation and capitalization.
- Keep the user's exact wording otherwise. Do NOT rephrase or "improve" content.
- Do NOT add anything (no greetings, no sign-offs, no editorializing).
- Output the cleaned text only — no preamble, no quotes.`;

export async function cleanDictation(raw: string): Promise<string> {
  if (!raw.trim()) return '';
  const response = await anthropic().messages.create({
    model: MODELS.liveExtract,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: raw }],
  });
  return response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
}

export async function applyTemplate(raw: string, systemPrompt: string): Promise<string> {
  if (!raw.trim()) return '';
  const response = await anthropic().messages.create({
    model: MODELS.liveExtract,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: raw }],
  });
  return response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
}
