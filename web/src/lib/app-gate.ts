/**
 * Remembers, in this browser tab only, that the `/app` gate (signed in and
 * onboarded) passed a moment ago, so moving between app pages doesn't wait on
 * a server round trip each time.
 *
 * Only a pass is remembered, only briefly, and only for the Clerk user it was
 * checked for: the pass is keyed on the client-side Clerk user id, so signing
 * out (in any tab, since Clerk syncs that) or switching to another account
 * makes it miss. While Clerk hasn't loaded there is no id and nothing is
 * cached. Every API route checks the session itself, so a stale pass could
 * show the app shell but never anyone's data. The server render always runs
 * the real gate.
 */
const GATE_TTL_MS = 60_000;

let passedAt = 0;
let passedFor: string | null = null;

type ClerkGlobal = { Clerk?: { user?: { id?: unknown } | null } | null };

function clerkUserId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = (window as ClerkGlobal).Clerk?.user?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function appGateRecentlyPassed(now = Date.now()): boolean {
  const userId = clerkUserId();
  return userId !== null && passedFor === userId && now - passedAt < GATE_TTL_MS;
}

export function rememberAppGatePass(now = Date.now()): void {
  const userId = clerkUserId();
  if (userId === null) {
    forgetAppGatePass();
    return;
  }
  passedAt = now;
  passedFor = userId;
}

export function forgetAppGatePass(): void {
  passedAt = 0;
  passedFor = null;
}
