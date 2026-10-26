/** How long a finished result stays open once nobody is editing it: long
 * enough to read the words, then fix, translate or copy them. */
export const DONE_HOLD_MS = 30_000;
/** How long a plain saved pill stays. */
export const SAVED_HOLD_MS = 3500;
/** How long a failure, or a save that says why the words weren't typed,
 * stays: long enough to read its line, then it gets out of the way. */
export const NOTICE_HOLD_MS = 6000;
/** How long a result stays once the pointer has been over it and left. */
export const LEFT_HOLD_MS = 2500;
/** The same for a finished dictation's drawer: the pointer often leaves it to
 * go read or click something, and the words should still be there after. */
export const DRAWER_LEFT_HOLD_MS = 10_000;
/** How long a result stays under a still pointer. macOS may never report the
 * pointer leaving a window that isn't key, so hovering can't hold it forever. */
export const OVER_HOLD_MS = 30_000;
/** The longest a hover can hold a result, however the pointer moves. */
export const OVER_MAX_MS = 120_000;
/** How long "Pasted" shows on the pill: the words are already in the app. */
export const PASTED_HOLD_MS = 1600;
/** How long "Copied" shows: time to click into a field and press ⌘V. */
export const COPIED_HOLD_MS = 6000;

/** What a finished dictation's pill says happened to the words, before its drawer is opened. */
export type Receipt = 'pasted' | 'copied' | 'blocked';

/** The phases that go back to the pill by themselves. */
export const HELD_PHASES: readonly string[] = ['saved', 'done', 'failed'];

/**
 * How long until a saved, finished or failed result collapses back to the
 * pill, or null to stay until dismissed. A receipt keeps its own time
 * whatever the pointer does: hovering it opens the drawer, which is held like
 * a result. `notice` is true when the result carries a line to read (a save
 * that says why the words weren't typed).
 */
export function holdMs(phase: string, pointer: 'away' | 'over' | 'left', overSince: number, now: number, receipt: Receipt | null = null, notice = false): number | null {
  // Not pasted needs Accessibility turned on: it stays until that's done or it's closed.
  if (receipt === 'blocked') return null;
  if (receipt) return receipt === 'pasted' ? PASTED_HOLD_MS : COPIED_HOLD_MS;
  if (pointer === 'over') return Math.max(0, Math.min(OVER_HOLD_MS, overSince + OVER_MAX_MS - now));
  if (pointer === 'left') return phase === 'done' ? DRAWER_LEFT_HOLD_MS : LEFT_HOLD_MS;
  if (phase === 'done') return DONE_HOLD_MS;
  return phase === 'failed' || notice ? NOTICE_HOLD_MS : SAVED_HOLD_MS;
}
