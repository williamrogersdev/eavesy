/** Cookie and redirect plumbing shared by the Connect Google start and callback routes. */
export const GOOGLE_STATE_COOKIE = 'ev_google_oauth';

export function googleRedirectUri(origin: string): string {
  return `${origin}/api/connections/google/callback`;
}

/** Back to Settings with the outcome; `from=mac` makes the page say to go back to the app. */
export function settingsRedirect(origin: string, from: 'mac' | 'web', params: string): Response {
  const suffix = from === 'mac' ? '&from=mac' : '';
  return new Response(null, { status: 302, headers: { location: `${origin}/app/settings?${params}${suffix}` } });
}

export function readStateCookie(request: Request): { state: string; verifier: string; from: 'mac' | 'web' } | null {
  const cookies = request.headers.get('cookie') ?? '';
  for (const part of cookies.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name !== GOOGLE_STATE_COOKIE || !value) continue;
    const [state, verifier, from] = value.split('.');
    if (!state || !verifier) return null;
    return { state, verifier, from: from === 'mac' ? 'mac' : 'web' };
  }
  return null;
}

export function clearStateCookie(response: Response): Response {
  response.headers.append('set-cookie', `${GOOGLE_STATE_COOKIE}=; Path=/api/connections/google; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
  return response;
}
