import { sameWriting, type DictationStyle, type Writing } from '@/lib/transcription/dictation-style';

/** Words that no tone was applied to: fillers dropped, nothing else. */
export const PLAIN: Writing = { style: 'natural', forAgents: false };

/**
 * The tone in force for a finished dictation's words, as the server told the
 * app with them: the saved choice (the project's own when it set one), and
 * whether the model applied it. When it didn't, the words went out plain.
 */
export interface WrittenAs extends Writing {
  projectId: string | null;
  applied: boolean;
}

/** A tone change under way or landed on this dictation: what was picked, and the tone the words started in. */
export interface TonePick {
  from: Writing;
  pick: DictationStyle;
  forAgents: boolean;
}

/**
 * What the tone row shows as picked, and the tone the words as pasted are
 * in (`from`: picking it again puts them back without a rewrite).
 *
 * The row is the setting, so without a change it shows the setting in
 * force: what the server said, else the account's saved choice, else the
 * plain default. The words are in that tone only when the model applied it;
 * otherwise, or when the server didn't say (words corrected live, offline),
 * they count as plain, so a change rewrites them from there.
 */
export function toneRow(written: WrittenAs | null | undefined, prefs: Writing | null, change: TonePick | null): { picked: Writing; from: Writing } {
  const setting: Writing = written ? { style: written.style, forAgents: written.forAgents } : prefs ?? PLAIN;
  const from = change?.from ?? (written?.applied ? setting : PLAIN);
  const picked = change ? { style: change.pick, forAgents: change.forAgents } : setting;
  return { picked, from };
}

/**
 * What making `next` the choice does to the words: nothing, when they are
 * already in that tone (picked, and the tone they went out in); put back as
 * pasted, when it is the tone they went out in; otherwise a rewrite, even
 * of the tone shown as picked when the words aren't in it (words that went
 * out plain under a saved tone).
 */
export function needsRewrite(next: Writing, row: { picked: Writing; from: Writing }): 'none' | 'restore' | 'rewrite' {
  if (!sameWriting(next, row.from)) return 'rewrite';
  return sameWriting(next, row.picked) ? 'none' : 'restore';
}

/**
 * What the row does after a change: kept first (the row is the setting, so
 * a choice that can't be kept isn't made at all, and the row goes back),
 * then the words rewritten. Kept but not rewritten keeps the choice, with
 * the words as they were, and says so.
 */
export function changeOutcome(kept: boolean, rewritten: boolean): { revert: boolean; say: string | null } {
  if (!kept) return { revert: true, say: 'Couldn’t change the tone. Try again?' };
  if (!rewritten) return { revert: false, say: 'Kept for next time, but this one couldn’t be rewritten' };
  return { revert: false, say: null };
}
