/**
 * Remembers, in this browser tab only, that the `/app` gate (signed in and
 * onboarded) passed a moment ago, so moving between app pages doesn't wait on
 * a server round trip each time.
 *
 * Only a pass is remembered, and only briefly. Both conditions it stands for
 * hold until the user signs out (onboarding can't be undone), and every API
 * route checks the session itself, so a stale pass can show the app shell for
 * at most GATE_TTL_MS but never anyone's data. Signing out forgets it at once.
 * The server render always runs the real gate.
 */
const GATE_TTL_MS = 60_000;

let passedAt = 0;

export function appGateRecentlyPassed(now = Date.now()): boolean {
  return typeof window !== 'undefined' && passedAt > 0 && now - passedAt < GATE_TTL_MS;
}

export function rememberAppGatePass(now = Date.now()): void {
  if (typeof window !== 'undefined') passedAt = now;
}

export function forgetAppGatePass(): void {
  passedAt = 0;
}
