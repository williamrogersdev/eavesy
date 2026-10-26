import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildGoogleAuthorizeUrl,
  emailFromIdToken,
  GoogleAccessRevoked,
  listGoogleEvents,
  meetingLinkOf,
  parseGoogleEvent,
  refreshGoogleAccess,
  revokeGoogleToken,
} from './google-calendar';
import { readStateCookie, settingsRedirect, stateCookie, userTag } from './google-oauth-flow';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers every fetch with `respond`, recording each request. */
function mockFetch(respond: (url: string, init?: RequestInit) => Response): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return calls;
}

function idToken(payload: object): string {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `header.${body}.signature`;
}

describe('Google OAuth', () => {
  test('asks for offline, read-only calendar access with PKCE', () => {
    const url = new URL(buildGoogleAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://eavesy.com/cb', state: 's1', codeChallenge: 'c1' }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('calendar.events.readonly');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('s1');
  });

  test('reads the email from an id_token meant for this client', () => {
    const google = { iss: 'https://accounts.google.com', aud: 'cid' };
    expect(emailFromIdToken(idToken({ ...google, email: 'sam@example.com' }), 'cid')).toBe('sam@example.com');
    expect(emailFromIdToken(idToken({ ...google, aud: 'someone-else', email: 'sam@example.com' }), 'cid')).toBeNull();
    expect(emailFromIdToken(idToken({ iss: 'https://evil.example', aud: 'cid', email: 'sam@example.com' }), 'cid')).toBeNull();
    expect(emailFromIdToken('not-a-token', 'cid')).toBeNull();
  });

  test('reads its state cookie back, and only its own', async () => {
    const user = await userTag('user_1');
    const cookie = stateCookie({ state: 'st', verifier: 'ver', from: 'mac', user }).split(';')[0];
    const request = new Request('https://eavesy.com/api/connections/google/callback', { headers: { cookie: `other=1; ${cookie}` } });
    expect(readStateCookie(request)).toEqual({ state: 'st', verifier: 'ver', from: 'mac', user });
    expect(user).not.toBe(await userTag('user_2'));
    expect(readStateCookie(new Request('https://eavesy.com', { headers: { cookie: 'other=1' } }))).toBeNull();
    expect(readStateCookie(new Request('https://eavesy.com', { headers: { cookie: 'ev_google_oauth=st.ver.mac' } }))).toBeNull();
  });

  test('a refused refresh token means connect again, other failures don’t', async () => {
    const creds = { clientId: 'cid', clientSecret: 'secret' };
    mockFetch(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    await expect(refreshGoogleAccess(creds, 'rt')).rejects.toBeInstanceOf(GoogleAccessRevoked);
    mockFetch(() => Response.json({ error: 'server_error' }, { status: 500 }));
    const failure = await refreshGoogleAccess(creds, 'rt').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GoogleAccessRevoked);
  });

  test('revokes with the token in the body, never the URL', async () => {
    const calls = mockFetch(() => new Response(null, { status: 200 }));
    expect(await revokeGoogleToken('secret-token')).toBe(true);
    expect(calls[0].url).not.toContain('secret-token');
    expect(String(calls[0].init?.body)).toBe('token=secret-token');
    mockFetch(() => new Response(null, { status: 503 }));
    expect(await revokeGoogleToken('secret-token')).toBe(false);
  });

  test('sends a Mac-started connection back with from=mac', () => {
    expect(settingsRedirect('https://eavesy.com', 'mac', 'connected=google').headers.get('location')).toBe(
      'https://eavesy.com/app/settings?connected=google&from=mac',
    );
  });
});

describe('Google events', () => {
  test('keeps a Meet event with its people', () => {
    const event = parseGoogleEvent({
      id: 'e1',
      summary: ' Weekly sync ',
      start: { dateTime: '2026-10-27T10:00:00Z' },
      end: { dateTime: '2026-10-27T10:30:00Z' },
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
      attendees: [{ email: 'a@example.com', displayName: 'A' }, { email: 'b@example.com' }, { self: true }],
    });
    expect(event).toEqual({
      providerEventId: 'e1',
      title: 'Weekly sync',
      startsAt: Date.parse('2026-10-27T10:00:00Z'),
      endsAt: Date.parse('2026-10-27T10:30:00Z'),
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
      platform: 'meet',
      participants: [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com', name: null }],
    });
  });

  test('drops cancelled and undated events', () => {
    expect(parseGoogleEvent({ id: 'x', status: 'cancelled', start: { date: '2026-10-27' }, end: { date: '2026-10-28' } })).toBeNull();
    expect(parseGoogleEvent({ id: 'y', start: {}, end: {} })).toBeNull();
  });

  test('a listing cut short at the page cap says so', async () => {
    const event = { id: 'e', start: { dateTime: '2026-10-27T10:00:00Z' }, end: { dateTime: '2026-10-27T11:00:00Z' } };
    mockFetch(() => Response.json({ items: [event], nextPageToken: 'more' }));
    const capped = await listGoogleEvents('at', 0, 1);
    expect(capped.complete).toBe(false);
    expect(capped.events).toHaveLength(4);
    mockFetch(() => Response.json({ items: [event] }));
    expect((await listGoogleEvents('at', 0, 1)).complete).toBe(true);
    mockFetch(() => new Response(null, { status: 401 }));
    await expect(listGoogleEvents('at', 0, 1)).rejects.toBeInstanceOf(GoogleAccessRevoked);
  });

  test('prefers the event’s own conference link and ignores look-alike hosts', () => {
    expect(meetingLinkOf({ hangoutLink: 'https://meet.google.com/abc-defg-hij', description: 'https://zoom.us/j/123' })?.platform).toBe('meet');
    expect(meetingLinkOf({ location: 'https://notzoom.us.evil.example/j/123' })).toBeNull();
    expect(meetingLinkOf({ location: 'https://zoom.us/w/webinar-signup' })).toBeNull();
  });

  test('finds Zoom and Teams links in the location or description', () => {
    expect(meetingLinkOf({ location: 'https://us02web.zoom.us/j/123456?pwd=abc' })?.platform).toBe('zoom');
    expect(meetingLinkOf({ description: 'Join: https://teams.microsoft.com/l/meetup-join/19%3a123 now' })?.platform).toBe('teams');
    expect(meetingLinkOf({ location: 'Room 4' })).toBeNull();
  });
});
