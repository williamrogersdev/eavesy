/** The tone a dictation is rewritten in before it is typed. `natural` keeps the speaker's own words. */
export const DICTATION_STYLES = [
  { id: 'natural', label: 'As spoken', hint: 'Tidied up, in your own words and tone.' },
  { id: 'professional', label: 'Professional', hint: 'Clear, polished and neutral. No swearing.' },
  { id: 'friendly', label: 'Friendly', hint: 'Warm, upbeat and supportive. No swearing.' },
  { id: 'concise', label: 'Concise', hint: 'Just the point, in as few words as it takes. No swearing.' },
] as const;

export const FOR_AGENTS_HINT =
  'Structured as a prompt: the ask first, then context, requirements and constraints. Works with any tone. No swearing.';

export type DictationStyle = (typeof DICTATION_STYLES)[number]['id'];

export const DEFAULT_DICTATION_STYLE: DictationStyle = 'natural';

export function isDictationStyle(value: unknown): value is DictationStyle {
  return DICTATION_STYLES.some((style) => style.id === value);
}

export function dictationStyle(value: unknown): DictationStyle {
  return isDictationStyle(value) ? value : DEFAULT_DICTATION_STYLE;
}

const SWEARING =
  /\b(?:the\s+)?(?:fuck\w*|motherfuck\w*|shit\w*|bullshit\w*|goddamn\w*|damn(?:ed|it)?|ass(?:hole)?s?|bitch\w*|crap\w*|bloody|piss(?:ed)?)\b/gi;

/** Swear words dropped from text the model couldn't restyle, so a clean style never types them. */
export function withoutSwearing(text: string): string {
  const out = text
    .replace(SWEARING, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[,.;:!?])/g, '')
    .replace(/^[\s,.;:]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}
