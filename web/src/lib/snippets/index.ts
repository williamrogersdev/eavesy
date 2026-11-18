/**
 * Voice snippets: say the trigger in a dictation and Eavesy types the text
 * instead. A snippet tagged with a form field is also what the Mac's Fill
 * field shortcut pastes into a field asking for it. The Mac matches field
 * labels to these keys itself (`desktop/src-tauri/src/form_fill.rs`); keep the
 * two lists the same.
 */
export const SNIPPET_FIELDS = [
  { key: 'name', label: 'Full name' },
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'company', label: 'Company' },
  { key: 'job_title', label: 'Job title' },
  { key: 'address', label: 'Street address' },
  { key: 'city', label: 'City' },
  { key: 'postcode', label: 'Postcode or ZIP' },
  { key: 'country', label: 'Country' },
  { key: 'website', label: 'Website' },
] as const;

export type SnippetField = (typeof SNIPPET_FIELDS)[number]['key'];

export const MAX_SNIPPETS = 200;
export const MAX_TRIGGER = 64;
export const MAX_SNIPPET_TEXT = 2_000;

const FIELD_KEYS = new Set<string>(SNIPPET_FIELDS.map((field) => field.key));

export function isSnippetField(value: unknown): value is SnippetField {
  return typeof value === 'string' && FIELD_KEYS.has(value);
}

export function fieldLabel(field: string | null | undefined): string | null {
  return SNIPPET_FIELDS.find((option) => option.key === field)?.label ?? null;
}

/** One snippet per phrase, whatever its case or spacing. */
export function triggerKey(trigger: string): string {
  return trigger.trim().split(/\s+/).join(' ').toLowerCase();
}

/**
 * Why a snippet can't be saved, or null when it can. A trigger is spoken, so
 * it needs letters and at least two words: one word ("email") would replace
 * the word every time it's said.
 */
export function snippetProblem(trigger: string, text: string): string | null {
  const key = triggerKey(trigger);
  if (!key) return 'Say what you’ll say to insert it.';
  if (key.length > MAX_TRIGGER) return `Keep the phrase under ${MAX_TRIGGER} characters.`;
  if (!/\p{L}/u.test(key)) return 'The phrase needs words you can say.';
  if (key.split(' ').length < 2) return 'Use at least two words, like “my email”, so the phrase isn’t replaced every time you say the word.';
  if (!text.trim()) return 'Add the text to insert.';
  if (text.length > MAX_SNIPPET_TEXT) return `Keep the text under ${MAX_SNIPPET_TEXT.toLocaleString('en-US')} characters.`;
  return null;
}
