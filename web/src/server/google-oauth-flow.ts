import { sha256Hex } from '@/lib/sha256';

/** Cookie and redirect plumbing shared by the Connect Google start and callback routes. */
export const GOOGLE_STATE_COOKIE = 'ev_google_oauth';

export type SavedState = { state: string; verifier: string; from: 'mac' | 'web'; user: string };

/** Ties the flow to whoever started it, so a cookie left behind can't finish it for someone else. */
export async function userTag(userId: string): Promise<string> {
  return (await sha256Hex(`google-oauth:${userId}`)).slice(0, 32);
}

/** state, verifier and the user tag are base64url or hex, so '.' never appears inside one. */
export function stateCookie(saved: SavedState): string {
  return `${GOOGLE_STATE_COOKIE}=${saved.state}.${saved.verifier}.${saved.from}.${saved.user}; Path=/api/connections/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function googleRedirectUri(origin: string): string {
  return `${origin}/api/connections/google/callback`;
}

/** Back to Settings with the outcome; `from=mac` makes the page say to go back to the app. */
export function settingsRedirect(origin: string, from: 'mac' | 'web', params: string): Response {
  const suffix = from === 'mac' ? '&from=mac' : '';
  return new Response(null, { status: 302, headers: { location: `${origin}/app/settings?${params}${suffix}` } });
}

export function readStateCookie(request: Request): SavedState | null {
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== GOOGLE_STATE_COOKIE) continue;
    const [state, verifier, from, user, ...rest] = pair.slice(eq + 1).split('.');
    if (!state || !verifier || !user || rest.length) return null;
    return { state, verifier, from: from === 'mac' ? 'mac' : 'web', user };
  }
  return null;
}

export function clearStateCookie(response: Response): Response {
  response.headers.append('set-cookie', `${GOOGLE_STATE_COOKIE}=; Path=/api/connections/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return response;
}
