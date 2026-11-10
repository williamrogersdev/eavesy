import { isRecord } from '@/lib/json';
import { accountCall, isDesktop, openWebApp } from '@/lib/desktop/bridge';
import type { CaptureMode } from '@/lib/meetings/capture-plan';

export interface CalendarConnection {
  id: string;
  provider: 'google' | 'outlook';
  accountEmail: string;
  lastSyncAt: number | null;
  upcoming: number;
  needsReconnect: boolean;
  /** The last sync didn't work, so the meetings listed may be out of date. */
  syncFailing: boolean;
  /** The account's calendars and which are synced; null when the grant can't list them. */
  calendars: CalendarChoice[] | null;
  /** Connecting again would let Eavesy sync this account's other calendars too. */
  canAddCalendars: boolean;
}
export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  selected: boolean;
}

function parseCalendars(value: unknown): CalendarChoice[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) =>
    isRecord(item) && typeof item.id === 'string' && typeof item.name === 'string'
      ? [{ id: item.id, name: item.name, primary: item.primary === true, selected: item.selected === true }]
      : [],
  );
}
export interface CalendarStatus {
  available: { google: boolean; outlook: boolean };
  connections: CalendarConnection[];
}

function parseConnection(item: unknown): CalendarConnection[] {
  if (!isRecord(item) || typeof item.id !== 'string' || typeof item.accountEmail !== 'string') return [];
  if (item.provider !== 'google' && item.provider !== 'outlook') return [];
  return [{
    id: item.id,
    provider: item.provider,
    accountEmail: item.accountEmail,
    lastSyncAt: typeof item.lastSyncAt === 'number' ? item.lastSyncAt : null,
    upcoming: typeof item.upcoming === 'number' ? item.upcoming : 0,
    needsReconnect: item.needsReconnect === true,
    syncFailing: item.syncFailing === true,
    calendars: parseCalendars(item.calendars),
    canAddCalendars: item.canAddCalendars === true,
  }];
}

/** `/api/calendar-connections`' answer, or null when it isn't one. */
export function parseCalendarStatus(value: unknown): CalendarStatus | null {
  if (!isRecord(value) || !isRecord(value.available) || !Array.isArray(value.connections)) return null;
  return {
    available: { google: value.available.google === true, outlook: value.available.outlook === true },
    connections: value.connections.flatMap(parseConnection),
  };
}

/** Calls `/api/calendar-connections` as this Mac when in the app, or as the signed-in browser. */
async function call(method: 'GET' | 'DELETE' | 'PATCH', body?: unknown): Promise<unknown> {
  if (isDesktop()) return await accountCall(method, '/api/calendar-connections', body);
  const response = await fetch('/api/calendar-connections', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error('Couldn’t reach eavesy.com. Try again.');
  return await response.json().catch(() => null);
}

export async function getCalendarStatus(): Promise<CalendarStatus> {
  const status = parseCalendarStatus(await call('GET'));
  if (!status) throw new Error('eavesy.com sent an answer Eavesy couldn’t read.');
  return status;
}

/** Ticks or unticks calendars on one connected account; the answer is its calendars as saved. */
export async function setSyncedCalendars(id: string, calendars: { id: string; selected: boolean }[]): Promise<CalendarChoice[]> {
  const answer = await call('PATCH', { id, calendars });
  const saved = isRecord(answer) && answer.ok === true ? parseCalendars(answer.calendars) : null;
  if (!saved) throw new Error('Couldn’t save that. Try again.');
  return saved;
}

/** Why Disconnect stopped short: Google wasn't told, so the connection was kept. */
export const NOT_REVOKED =
  'Google couldn’t be told to stop sharing this calendar, so it’s still connected. Try again, or remove it from Eavesy anyway and then remove Eavesy from the apps connected to your Google Account at myaccount.google.com/connections.';

/** Disconnects. False when Google couldn't be told and `force` wasn't set: the connection is kept. */
export async function disconnectCalendar(id: string, force = false): Promise<boolean> {
  const answer = await call('DELETE', force ? { id, force } : { id });
  return !(isRecord(answer) && answer.ok === false);
}

/** A meeting ahead on the calendar, and whether to record it (null: as the Mac's setting says). */
export interface UpcomingMeeting {
  id: string;
  title: string;
  startsAt: number;
  endsAt: number;
  meetingUrl: string | null;
  recordChoice: 'record' | 'skip' | null;
  /** This meeting's own capture choice; null follows the account default. */
  captureMode: CaptureMode | null;
  /** What happens: its own choice, else the default. */
  mode: CaptureMode;
  /** A Meet or Teams call the Notetaker can join. */
  notetakerCanJoin: boolean;
  /** Who's invited, as the calendar lists them. */
  attendees: MeetingAttendee[];
}

export interface MeetingAttendee {
  email: string;
  name: string | null;
}

function parseAttendees(value: unknown): MeetingAttendee[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => isRecord(item) && typeof item.email === 'string'
    ? [{ email: item.email, name: typeof item.name === 'string' && item.name.trim() ? item.name : null }]
    : []);
}

const MODES: readonly CaptureMode[] = ['mac', 'notetaker', 'both', 'skip'];
const asMode = (value: unknown): CaptureMode | null => (MODES.includes(value as CaptureMode) ? (value as CaptureMode) : null);

/** One meeting from `/api/calendar-events` (or the Mac app's menu bar), or null when it isn't one. */
export function parseUpcomingMeeting(item: unknown): UpcomingMeeting | null {
  if (!isRecord(item) || typeof item.id !== 'string' || typeof item.title !== 'string') return null;
  if (typeof item.startsAt !== 'number' || typeof item.endsAt !== 'number') return null;
  const choice = item.recordChoice === 'record' || item.recordChoice === 'skip' ? item.recordChoice : null;
  // An older server sends only recordChoice.
  const mode = asMode(item.mode) ?? (choice === 'skip' ? 'skip' : 'mac');
  return {
    id: item.id,
    title: item.title,
    startsAt: item.startsAt,
    endsAt: item.endsAt,
    meetingUrl: typeof item.meetingUrl === 'string' ? item.meetingUrl : null,
    recordChoice: choice,
    captureMode: asMode(item.captureMode),
    mode,
    notetakerCanJoin: item.notetakerCanJoin === true,
    attendees: parseAttendees(item.attendees),
  };
}

function parseMeeting(item: unknown): UpcomingMeeting[] {
  const meeting = parseUpcomingMeeting(item);
  return meeting ? [meeting] : [];
}

/** `/api/calendar-events`' upcoming meetings, or null when it isn't that answer. */
export function parseUpcoming(value: unknown): UpcomingMeeting[] | null {
  if (!isRecord(value) || !Array.isArray(value.upcoming)) return null;
  return value.upcoming.flatMap(parseMeeting);
}

/** The meetings in the next day, as this Mac (device token) or the signed-in browser; null with no calendar connected. */
export async function getUpcomingMeetings(): Promise<UpcomingMeeting[] | null> {
  const answer = isDesktop()
    ? await accountCall('GET', '/api/calendar-events')
    : await fetch('/api/calendar-events').then((response) => {
      if (!response.ok) throw new Error('Couldn’t reach eavesy.com. Try again.');
      return response.json();
    });
  const meetings = parseUpcoming(answer);
  if (!meetings) throw new Error('eavesy.com sent an answer Eavesy couldn’t read.');
  return isRecord(answer) && answer.connected === false ? null : meetings;
}

/** Records whether to record one meeting; null goes back to the "record all" setting. */
export async function setRecordChoice(id: string, recordChoice: 'record' | 'skip' | null): Promise<void> {
  const path = `/api/calendar-events/${encodeURIComponent(id)}`;
  if (isDesktop()) {
    await accountCall('PATCH', path, { recordChoice });
    return;
  }
  const response = await fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recordChoice }) });
  if (!response.ok) throw new Error('Couldn’t save that. Try again.');
}

/** Sets how one meeting is captured; null goes back to the account default. */
export async function setCaptureMode(id: string, captureMode: CaptureMode | null): Promise<void> {
  const path = `/api/calendar-events/${encodeURIComponent(id)}`;
  if (isDesktop()) {
    await accountCall('PATCH', path, { captureMode });
    return;
  }
  const response = await fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ captureMode }) });
  if (!response.ok) throw new Error('Couldn’t save that. Try again.');
}

/** The account's meeting capture settings, from `/api/me`. */
export interface MeetingCapturePrefs {
  captureDefault: Exclude<CaptureMode, 'skip'>;
  /** The name typed in Settings; null when none was. */
  notetakerName: string | null;
  /** The name the Notetaker joins under now. */
  joinsAs: string;
  /** Whether this Eavesy server can send the Notetaker at all. */
  notetakerAvailable: boolean;
}

async function meCall(method: 'GET' | 'PATCH', body?: unknown): Promise<unknown> {
  if (isDesktop()) return await accountCall(method, '/api/me', body);
  const response = await fetch('/api/me', {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error(method === 'GET' ? 'Couldn’t load your settings.' : 'Couldn’t save that. Try again.');
  return await response.json().catch(() => null);
}

export function parseMeetingCapture(me: unknown): MeetingCapturePrefs | null {
  if (!isRecord(me)) return null;
  const captureDefault = me.meetingCaptureDefault === 'notetaker' || me.meetingCaptureDefault === 'both' ? me.meetingCaptureDefault : 'mac';
  return {
    captureDefault,
    notetakerName: typeof me.notetakerName === 'string' ? me.notetakerName : null,
    joinsAs: typeof me.notetakerJoinsAs === 'string' ? me.notetakerJoinsAs : 'Eavesy Notetaker',
    notetakerAvailable: me.notetakerAvailable === true,
  };
}

export async function getMeetingCapture(): Promise<MeetingCapturePrefs> {
  const prefs = parseMeetingCapture(await meCall('GET'));
  if (!prefs) throw new Error('eavesy.com sent an answer Eavesy couldn’t read.');
  return prefs;
}

export async function saveMeetingCapture(change: { meetingCaptureDefault?: MeetingCapturePrefs['captureDefault']; notetakerName?: string | null }): Promise<void> {
  await meCall('PATCH', change);
}

/** Google's consent screen runs in the browser; the Mac app opens it there and checks again when you come back. */
export async function connectGoogle(): Promise<void> {
  if (isDesktop()) await openWebApp('/connect-google#mac');
  else window.location.assign('/api/connections/google');
}

/** What Settings says when the last calendar sync failed: since when the meetings may be out of date. */
export function syncFailingLine(lastSyncAt: number | null, now: number): string {
  if (lastSyncAt === null) return 'Couldn’t sync this calendar yet. Eavesy keeps trying.';
  const minutes = Math.max(1, Math.round((now - lastSyncAt) / 60_000));
  const ago = minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return `Couldn’t sync for ${ago}, so new meetings may be missing. Eavesy keeps trying.`;
}
