import { OPENROUTER_MODELS, openRouterChat } from '@/lib/providers/openrouter-chat';
import { anthropic, anthropicForUser, MODELS } from './client';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatMeetingInput {
  context: string;
  history: ChatTurn[];
  openRouter?: { apiKey: string } | null;
  byoApiKey?: string;
}

function systemPrompt(context: string): string {
  return `You are Eavesy's meeting assistant. Answer the user's questions about ONE specific recorded meeting, using only the context below.

Rules:
- Ground every answer in the meeting context. If something isn't in it, say you don't see it in this meeting rather than guessing.
- Be concise and direct. Use short paragraphs or bullets.
- When useful, attribute points to the speaker who made them.
- You may summarize, extract action items, draft follow-up messages, or answer specific questions — all based on this meeting.

=== MEETING CONTEXT ===
${context}
=== END MEETING CONTEXT ===`;
}

export async function chatWithMeeting(input: ChatMeetingInput): Promise<string> {
  const system = systemPrompt(input.context);
  const history = input.history.slice(-20);

  if (input.openRouter) {
    const text = await openRouterChat({
      apiKey: input.openRouter.apiKey,
      model: OPENROUTER_MODELS.summary,
      maxTokens: 1024,
      messages: [{ role: 'system', content: system }, ...history],
    });
    return text.trim();
  }

  const client = input.byoApiKey ? anthropicForUser(input.byoApiKey) : anthropic();
  const response = await client.messages.create({
    model: MODELS.summary,
    max_tokens: 1024,
    system,
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });
  return response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
}
