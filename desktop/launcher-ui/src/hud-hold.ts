/** How long a finished result stays open once nobody is editing it. */
export const DONE_HOLD_MS = 10_000;
/** How long a result stays once the pointer has been over it and left. */
export const LEFT_HOLD_MS = 2500;
/** How long a result stays under a still pointer. macOS may never report the
 * pointer leaving a window that isn't key, so hovering can't hold it forever. */
export const OVER_HOLD_MS = 30_000;
/** The longest a hover can hold a result, however the pointer moves. */
export const OVER_MAX_MS = 120_000;

/** How long until a saved or finished result collapses back to the pill. */
export function holdMs(phase: string, pointer: 'away' | 'over' | 'left', overSince: number, now: number): number {
  if (pointer === 'over') return Math.max(0, Math.min(OVER_HOLD_MS, overSince + OVER_MAX_MS - now));
  if (pointer === 'left') return LEFT_HOLD_MS;
  return phase === 'done' ? DONE_HOLD_MS : 3500;
}
