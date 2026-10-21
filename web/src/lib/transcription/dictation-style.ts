/** The tone a dictation is rewritten in before it is typed. `natural` keeps the speaker's own words. */
export const DICTATION_STYLES = [
  { id: 'natural', label: 'As spoken', hint: 'Tidied up, in your own words and tone.' },
  { id: 'professional', label: 'Professional', hint: 'Clear, polished and neutral. No swearing.' },
  { id: 'friendly', label: 'Friendly', hint: 'Warm, upbeat and supportive. No swearing.' },
  { id: 'concise', label: 'Concise', hint: 'Just the point, in as few words as it takes. No swearing.' },
] as const;

/** Matches AGENT_BRIEF in lib/ai/agent-transcript.ts: keep the two in step. */
export const FOR_AGENTS_HINT =
  'Rewrites what you say as a prompt for Claude, ChatGPT or a coding agent: what you want first, then context, requirements and constraints. Headings only when it’s long, and nothing you didn’t say. Works with any tone. No swearing.';

/** One sentence, said out loud, and what each choice types for it. Shown beside the style pickers. */
export const DICTATION_EXAMPLE = {
  said: 'um so can you rename the summarize file to summary and uh fix the imports, the build keeps failing. oh and don’t touch the API',
  typed: {
    natural: 'Can you rename the `summarize` file to `summary` and fix the imports? The build keeps failing. Don’t touch the API.',
    professional: 'Could you rename the `summarize` file to `summary` and update the imports? The build is currently failing. Please leave the API unchanged.',
    friendly: 'Could you rename the `summarize` file to `summary` and fix up the imports? The build keeps failing, so that would really help. Just leave the API as it is, thanks.',
    concise: 'Rename `summarize` to `summary` and fix the imports; the build is failing. Don’t touch the API.',
  },
  forAgents: {
    natural: 'Rename the `summarize` file to `summary` and fix the imports.\n\nThe build keeps failing.\n\nDon’t touch the API.',
    professional: 'Rename the `summarize` file to `summary` and update the imports.\n\nContext: the build is currently failing.\n\nConstraint: leave the API unchanged.',
    friendly: 'Please rename the `summarize` file to `summary` and fix up the imports.\n\nThe build keeps failing, so this would really help.\n\nLeave the API as it is.',
    concise: 'Rename `summarize` to `summary` and fix the imports.\n\nContext: build failing.\nConstraint: don’t touch the API.',
  },
} as const satisfies { said: string; typed: Record<DictationStyle, string>; forAgents: Record<DictationStyle, string> };

export type DictationStyle = (typeof DICTATION_STYLES)[number]['id'];

export const DEFAULT_DICTATION_STYLE: DictationStyle = 'natural';

export function isDictationStyle(value: unknown): value is DictationStyle {
  return DICTATION_STYLES.some((style) => style.id === value);
}

export function dictationStyle(value: unknown): DictationStyle {
  return isDictationStyle(value) ? value : DEFAULT_DICTATION_STYLE;
}

/** How a dictation is written: the project's choice where it made one, the account's otherwise. */
export function effectiveDictation(
  account: { dictationStyle?: string | null; dictationForAgents?: boolean | null } | null | undefined,
  project?: { dictationStyle?: DictationStyle | null; dictationForAgents?: boolean | null } | null,
): { style: DictationStyle; forAgents: boolean } {
  return {
    style: project?.dictationStyle ?? dictationStyle(account?.dictationStyle),
    forAgents: project?.dictationForAgents ?? account?.dictationForAgents ?? false,
  };
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
