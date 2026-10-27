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

/** A rewrite tone the drawer and the history row offer: the words as saved, or any style but the plain one. */
export type Tone = 'original' | Exclude<DictationStyle, 'natural'>;

export interface ToneChoice { id: Tone; label: string; hint: string }

/** The tone buttons, with the caller's own wording for what "Original" means there. */
export function toneChoices(originalHint: string): ToneChoice[] {
  return [
    { id: 'original', label: 'Original', hint: originalHint },
    ...DICTATION_STYLES.filter((style): style is Extract<typeof style, { id: Tone }> => style.id !== 'natural'),
  ];
}

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

/** The tone a request asked for, over the saved one: a rewrite of one dictation, from the Mac app or the history. */
export function requestedDictation(
  request: { style?: DictationStyle; forAgents?: boolean },
  saved: { style: DictationStyle; forAgents: boolean },
): { style: DictationStyle; forAgents: boolean } {
  return { style: request.style ?? saved.style, forAgents: request.forAgents ?? saved.forAgents };
}

/** How a dictation is written: its tone, and as a prompt for an AI or not. */
export interface Writing { style: DictationStyle; forAgents: boolean }

/**
 * The tone a dictation's words are in, told back to the Mac app with them:
 * what was asked for, else the saved choice, and the project when that
 * choice is the project's own (so changing it changes the project, not the
 * account).
 */
export function writtenWith(
  request: { style?: DictationStyle; forAgents?: boolean },
  account: { dictationStyle?: string | null; dictationForAgents?: boolean | null } | null | undefined,
  project?: { id: string; dictationStyle?: DictationStyle | null; dictationForAgents?: boolean | null } | null,
): Writing & { projectId: string | null } {
  const own = !!project && (project.dictationStyle != null || project.dictationForAgents != null);
  return { ...requestedDictation(request, effectiveDictation(account, project)), projectId: own ? project.id : null };
}

export function sameWriting(a: Writing, b: Writing): boolean {
  return a.style === b.style && a.forAgents === b.forAgents;
}

/** A `Writing` read from a server reply or an event, or null when it isn't one. */
export function writingFrom(value: unknown): (Writing & { projectId: string | null }) | null {
  const raw = value as { style?: unknown; forAgents?: unknown; projectId?: unknown } | null;
  if (!raw || typeof raw !== 'object' || !isDictationStyle(raw.style)) return null;
  return { style: raw.style, forAgents: raw.forAgents === true, projectId: typeof raw.projectId === 'string' ? raw.projectId : null };
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
