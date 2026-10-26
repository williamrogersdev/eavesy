import { isRecord } from '@/lib/json';
import { accountCall, isDesktop, openWebApp } from '@/lib/desktop/bridge';

export interface CalendarConnection {
  id: string;
  provider: 'google' | 'outlook';
  accountEmail: string;
  lastSyncAt: number | null;
  upcoming: number;
  needsReconnect: boolean;
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
async function call(method: 'GET' | 'DELETE', body?: unknown): Promise<unknown> {
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

/** Why Disconnect stopped short: Google wasn't told, so the connection was kept. */
export const NOT_REVOKED =
  'Google couldn’t be told to stop sharing this calendar, so it’s still connected. Try again, or remove it from Eavesy anyway and then remove Eavesy from the apps connected to your Google Account at myaccount.google.com/connections.';

/** Disconnects. False when Google couldn't be told and `force` wasn't set: the connection is kept. */
export async function disconnectCalendar(id: string, force = false): Promise<boolean> {
  const answer = await call('DELETE', force ? { id, force } : { id });
  return !(isRecord(answer) && answer.ok === false);
}

/** Google's consent screen runs in the browser; the Mac app opens it there and checks again when you come back. */
export async function connectGoogle(): Promise<void> {
  if (isDesktop()) await openWebApp('/connect-google#mac');
  else window.location.assign('/api/connections/google');
}
