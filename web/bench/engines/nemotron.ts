import type { Turn } from './score';

export const NEMOTRON_MODEL = 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B';

/**
 * The model card's speaker-attribution prompt, verbatim, plus its "Context
 * terms" line when there is vocabulary. It names four tags; the model labels
 * up to eight speakers.
 */
export function nemotronPrompt(terms: readonly string[] = []): string {
  const prompt =
    'Transcribe this audio with punctuation and capitalization. Include all spoken words and verbal fillers. ' +
    'Write numbers in their standard written form. Put speaker tags <spk:0> <spk:1> <spk:2> <spk:3> on the transcription.';
  return terms.length ? `${prompt} Context terms: ${terms.join(', ')}.` : prompt;
}

/** An OpenAI-style chat completion, as the model card's vLLM server takes it. */
export function nemotronRequest(wav: Uint8Array, opts: { model?: string; terms?: readonly string[] } = {}) {
  return {
    model: opts.model ?? NEMOTRON_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: nemotronPrompt(opts.terms) },
          { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}` } },
        ],
      },
    ],
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
    skip_special_tokens: false,
  };
}

function content(response: unknown): string {
  const choice = (response as { choices?: { finish_reason?: unknown; message?: { content?: unknown } }[] })?.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('the transcript was cut off at the token limit');
  const value = choice?.message?.content;
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '';
  if (!text.trim()) throw new Error(`no transcript in the response: ${JSON.stringify(response).slice(0, 300)}`);
  return text;
}

/**
 * Turns from `<spk:N>` tags. Text before the first tag has no speaker. Other
 * angle-bracket tokens are the model's special tokens and are dropped, as is
 * any reasoning, closed or not.
 */
export function nemotronTurns(response: unknown): Turn[] {
  const text = content(response).replace(/<think>[\s\S]*?(<\/think>|$)/g, '');
  const turns: Turn[] = [];
  let speaker: string | null = null;
  for (const piece of text.split(/(<spk:\d+>)/)) {
    const tag = /^<spk:(\d+)>$/.exec(piece);
    if (tag) {
      speaker = `spk:${tag[1]}`;
      continue;
    }
    const said = piece.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (said) turns.push({ speaker, text: said });
  }
  if (turns.length === 0) throw new Error('no transcript after removing reasoning and special tokens');
  return turns;
}
