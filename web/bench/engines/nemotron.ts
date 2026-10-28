import type { Turn } from './score';

export const NEMOTRON_MODEL = 'nvidia/NVIDIA-Nemotron-3.5-Transcribe-30B-A4B';

/** The model card's speaker-attribution prompt, plus its "Context terms" line when there is vocabulary. */
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
  const message = (response as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message;
  const value = message?.content;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  throw new Error(`no transcript in the response: ${JSON.stringify(response).slice(0, 300)}`);
}

/** Turns from `<spk:N>` tags. Text before the first tag has no speaker; other special tokens are dropped. */
export function nemotronTurns(response: unknown): Turn[] {
  const text = content(response).replace(/<think>[\s\S]*?<\/think>/g, '');
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
  return turns;
}
