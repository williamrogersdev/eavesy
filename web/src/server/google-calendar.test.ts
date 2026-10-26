import { describe, expect, test } from 'bun:test';
import { buildGoogleAuthorizeUrl, emailFromIdToken, meetingLinkOf, parseGoogleEvent } from './google-calendar';
import { readStateCookie, settingsRedirect } from './google-oauth-flow';

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

  test('reads the email from an id_token', () => {
    expect(emailFromIdToken(idToken({ email: 'sam@example.com' }))).toBe('sam@example.com');
    expect(emailFromIdToken('not-a-token')).toBeNull();
  });

  test('reads its state cookie back, and only its own', () => {
    const request = new Request('https://eavesy.com/api/connections/google/callback', {
      headers: { cookie: 'other=1; ev_google_oauth=st.ver.mac' },
    });
    expect(readStateCookie(request)).toEqual({ state: 'st', verifier: 'ver', from: 'mac' });
    expect(readStateCookie(new Request('https://eavesy.com', { headers: { cookie: 'other=1' } }))).toBeNull();
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

  test('finds Zoom and Teams links in the location or description', () => {
    expect(meetingLinkOf({ location: 'https://us02web.zoom.us/j/123456?pwd=abc' })?.platform).toBe('zoom');
    expect(meetingLinkOf({ description: 'Join: https://teams.microsoft.com/l/meetup-join/19%3a123 now' })?.platform).toBe('teams');
    expect(meetingLinkOf({ location: 'Room 4' })).toBeNull();
  });
});
