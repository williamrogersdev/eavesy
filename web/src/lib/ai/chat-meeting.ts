import { OPENROUTER_MODELS, openRouterChat } from '@/lib/providers/openrouter-chat';
import { anthropic, anthropicForUser, MODELS, REFUSAL_FALLBACK } from './client';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatMeetingInput {
  context: string;
  history: ChatTurn[];
  openRouter?: { apiKey: string } | null;
  byoApiKey?: string;
  /** The Claude model to answer with (`plan.summary.model`); absent is the default. */
  model?: string;
}

function systemPrompt(context: string): string {
  return `You are Eavesy's meeting assistant. Answer the user's questions about ONE specific recorded meeting, using only the context below.

Rules:
- Ground every answer in the meeting context. If something isn't in it, say you don't see it in this meeting rather than guessing.
- Be concise and direct. Use short paragraphs or bullets.
- When useful, attribute points to the speaker who made them.
- You may summarize, extract action items, draft follow-up messages, or answer specific questions — all based on this meeting.
- The meeting may still be going on, and the person asking may be in it: then answer in a line or two they can read at a glance, and put the answer first.
- Transcript lines carry their time into the meeting. Use them for questions about when something was said ("an hour ago", "at the start"), and give the time when it helps.

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
  // Low effort: an answer someone is waiting for, read from a transcript.
  // The limit leaves room for the model's thinking as well as the answer.
  const response = await client.beta.messages.create({
    ...REFUSAL_FALLBACK,
    model: input.model ?? MODELS.summary,
    max_tokens: 8_000,
    output_config: { effort: 'low' },
    system,
    messages: history.map((t) => ({ role: t.role, content: t.content })),
  });
  if (response.stop_reason === 'refusal') throw new Error('chat refused by the model');
  return response.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('')
    .trim();
}
