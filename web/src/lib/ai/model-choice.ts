/**
 * The Claude models an account can choose between, in Settings on the web
 * and in the Mac app. Stored as the model id, or null for "Eavesy's default",
 * so a better default later reaches everyone who never chose.
 *
 * Only models that take the same requests are listed: adaptive thinking,
 * structured output, no sampling parameters. Adding one means checking the
 * calls in `summarize.ts`, `meeting-summary.ts`, `chat-meeting.ts` and
 * `server/assistant.ts` against it.
 */
export const MODEL_CHOICES = [
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', note: 'Fastest, and the least thorough.' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', note: 'Balanced: quick and thorough.' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', note: 'Most thorough, and slower.' },
] as const;

export type ModelChoice = (typeof MODEL_CHOICES)[number]['id'];

/** What writes a meeting's notes and answers questions about it, unless the account chose. */
export const DEFAULT_NOTES_MODEL: ModelChoice = 'claude-sonnet-5-5';
/** What Eavesy's assistant runs on, unless the account chose. */
export const DEFAULT_ASSISTANT_MODEL: ModelChoice = 'claude-sonnet-5-5';

export function isModelChoice(value: unknown): value is ModelChoice {
  return typeof value === 'string' && MODEL_CHOICES.some((choice) => choice.id === value);
}

/**
 * The model to use for a stored choice. A choice that is no longer offered
 * (a retired model) falls back to the default rather than failing the call.
 */
export function chosenModel(stored: string | null | undefined, fallback: ModelChoice): ModelChoice {
  return isModelChoice(stored) ? stored : fallback;
}

/** The model's name as Settings shows it, for an id that may no longer be offered. */
export function modelName(id: ModelChoice): string {
  return MODEL_CHOICES.find((choice) => choice.id === id)?.name ?? id;
}

/** The choices for a settings menu: the default first (value ''), then each model. */
export function modelOptions(fallback: ModelChoice): { value: string; label: string }[] {
  return [
    { value: '', label: `Default (${modelName(fallback).replace('Claude ', '')})` },
    ...MODEL_CHOICES.map((choice) => ({ value: choice.id, label: choice.name })),
  ];
}

/** What to say under the menu about the model in use. */
export function modelNote(stored: string | null | undefined, fallback: ModelChoice): string {
  const id = chosenModel(stored, fallback);
  return MODEL_CHOICES.find((choice) => choice.id === id)?.note ?? '';
}
