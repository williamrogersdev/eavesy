import { isRecord } from '@/lib/json';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** Read-only access to calendar events, plus the account's email to show it. */
export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.readonly'];

export type GoogleCredentials = { clientId: string; clientSecret: string };

/** The OAuth client from the Worker's secrets, or null when Google isn't set up on this deployment. */
export function googleCredentials(): GoogleCredentials | null {
  const env = typeof process !== 'undefined' ? process.env : {};
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Thrown when Google no longer accepts the refresh token: the person has to connect again. */
export class GoogleAccessRevoked extends Error {}

export function buildGoogleAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Always ask, so Google sends a refresh token even on a reconnect.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok || !isRecord(json)) {
    const code = isRecord(json) && typeof json.error === 'string' ? json.error : `http_${res.status}`;
    if (code === 'invalid_grant') throw new GoogleAccessRevoked(code);
    throw new Error(`google_token_${code}`);
  }
  return json;
}

/**
 * The email in an id_token. It came straight from Google's token endpoint over
 * TLS, so the signature isn't re-verified, but it must be Google's and ours.
 */
export function emailFromIdToken(idToken: string, clientId: string): string | null {
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!isRecord(json) || typeof json.email !== 'string') return null;
    if (json.aud !== clientId || (json.iss !== 'https://accounts.google.com' && json.iss !== 'accounts.google.com')) return null;
    return json.email;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(
  creds: GoogleCredentials,
  opts: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ refreshToken: string; accessToken: string; email: string; scopes: string[] }> {
  const json = await tokenRequest({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
    grant_type: 'authorization_code',
  });
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : null;
  const accessToken = typeof json.access_token === 'string' ? json.access_token : null;
  const email = typeof json.id_token === 'string' ? emailFromIdToken(json.id_token, creds.clientId) : null;
  if (!refreshToken || !accessToken || !email) throw new Error('google_token_incomplete');
  const scopes = typeof json.scope === 'string' ? json.scope.split(' ') : [];
  return { refreshToken, accessToken, email, scopes };
}

export async function refreshGoogleAccess(creds: GoogleCredentials, refreshToken: string, signal?: AbortSignal): Promise<string> {
  const json = await tokenRequest({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }, signal);
  if (typeof json.access_token !== 'string') throw new Error('google_token_incomplete');
  return json.access_token;
}

/** Asks Google to forget the grant, so the account's "Third-party access" list drops Eavesy. True when it did. */
export async function revokeGoogleToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
    });
    // 400 invalid_token: Google had already forgotten it.
    if (res.ok || res.status === 400) return true;
    console.error('[google-revoke] http', res.status);
    return false;
  } catch (error) {
    console.error('[google-revoke]', error);
    return false;
  }
}

export type CalendarEventInput = {
  providerEventId: string;
  title: string;
  startsAt: number;
  endsAt: number;
  meetingUrl: string | null;
  platform: 'meet' | 'zoom' | 'teams' | null;
  participants: { email: string; name: string | null }[];
};

/** Whole URLs in free text: a URL inside another URL's query stays part of that one. */
const URL_TOKEN = /https:\/\/[^\s"'<>()[\]]+/g;

/** The platform when `url` is a call's join link, judged by its parsed host and path. */
export function platformOf(url: URL): 'meet' | 'zoom' | 'teams' | null {
  const host = url.hostname.toLowerCase();
  if (host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname)) return 'meet';
  if ((host === 'zoom.us' || host.endsWith('.zoom.us')) && /^\/[jw]\/\d+$/.test(url.pathname)) return 'zoom';
  if (host === 'teams.microsoft.com' && url.pathname.startsWith('/l/meetup-join/')) return 'teams';
  if (host === 'teams.live.com' && /^\/meet\/\d+$/.test(url.pathname)) return 'teams';
  return null;
}

export function meetingLinkOf(event: Record<string, unknown>): { url: string; platform: 'meet' | 'zoom' | 'teams' } | null {
  const candidates: string[] = [];
  if (typeof event.hangoutLink === 'string') candidates.push(event.hangoutLink);
  const conference = isRecord(event.conferenceData) ? event.conferenceData : null;
  if (conference && Array.isArray(conference.entryPoints)) {
    for (const entry of conference.entryPoints) {
      if (isRecord(entry) && entry.entryPointType === 'video' && typeof entry.uri === 'string') candidates.push(entry.uri);
    }
  }
  if (typeof event.location === 'string') candidates.push(event.location);
  if (typeof event.description === 'string') candidates.push(event.description);
  // In order: the event's own conference link first, free text last.
  for (const text of candidates) {
    for (const match of text.matchAll(URL_TOKEN)) {
      const raw = match[0].replace(/[.,;:!?]+$/, '');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      const platform = platformOf(url);
      if (platform) return { url: raw, platform };
    }
  }
  return null;
}

function timeOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const raw = typeof value.dateTime === 'string' ? value.dateTime : typeof value.date === 'string' ? value.date : null;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Turns one item from Google's events list into a row, or null for cancelled or undated ones. */
export function parseGoogleEvent(event: unknown): CalendarEventInput | null {
  if (!isRecord(event) || typeof event.id !== 'string' || event.status === 'cancelled') return null;
  const startsAt = timeOf(event.start);
  const endsAt = timeOf(event.end);
  if (startsAt === null || endsAt === null) return null;
  const link = meetingLinkOf(event);
  const participants = Array.isArray(event.attendees)
    ? event.attendees.flatMap((a) =>
        isRecord(a) && typeof a.email === 'string' ? [{ email: a.email, name: typeof a.displayName === 'string' ? a.displayName : null }] : [],
      )
    : [];
  return {
    providerEventId: event.id,
    title: typeof event.summary === 'string' && event.summary.trim() ? event.summary.trim() : '(No title)',
    startsAt,
    endsAt,
    meetingUrl: link?.url ?? null,
    platform: link?.platform ?? null,
    participants,
  };
}

/** Up to 2,500 events in the 15-day window (Google may send fewer per page); past the cap the listing is marked incomplete and nothing is deleted. */
const MAX_PAGES = 10;

/**
 * Events on the primary calendar between `from` and `to`, recurring ones
 * expanded. `complete` is false when the listing stopped at the page cap, so
 * the caller must not treat a missing event as deleted.
 */
export async function listGoogleEvents(
  accessToken: string,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<{ events: CalendarEventInput[]; complete: boolean }> {
  const out: CalendarEventInput[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '250',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(`${EVENTS_URL}?${params.toString()}`, { headers: { authorization: `Bearer ${accessToken}` }, signal });
    if (res.status === 401) throw new GoogleAccessRevoked('unauthorized');
    if (!res.ok) throw new Error(`google_events_http_${res.status}`);
    const json: unknown = await res.json();
    if (!isRecord(json)) return { events: out, complete: false };
    if (Array.isArray(json.items)) {
      for (const item of json.items) {
        const parsed = parseGoogleEvent(item);
        if (parsed) out.push(parsed);
      }
    }
    pageToken = typeof json.nextPageToken === 'string' ? json.nextPageToken : undefined;
    if (!pageToken) return { events: out, complete: true };
  }
  return { events: out, complete: false };
}
