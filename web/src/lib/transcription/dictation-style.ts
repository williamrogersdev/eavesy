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

/** "What the hell" keeps its "what": the "the" goes only with the swear word after it. */
const THE_SWEAR = /\bthe\s+(?:fuck|hell|heck)\b/gi;
const SWEARING =
  /\b(?:fuck\w*|motherfuck\w*|wtf|shit\w*|bullshit\w*|goddamn\w*|god\s+damn\w*|damn(?:ed|it)?|dammit|ass(?:hole)?s?|dumbass\w*|jackass\w*|bitch\w*|crap\w*|bloody|piss(?:ed)?|hell)\b/gi;

/** Swear words dropped from typed text, so a clean style never types them. */
export function withoutSwearing(text: string): string {
  const out = text
    .replace(THE_SWEAR, '')
    .replace(SWEARING, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/([,;:])(?=[,.;:!?])/g, '')
    .replace(/^[\s,.;:]+/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return out ? out[0].toUpperCase() + out.slice(1) : out;
}
