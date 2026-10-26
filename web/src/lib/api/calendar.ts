import { z } from 'zod';
import { accountCall, isDesktop, openWebApp } from '@/lib/desktop/bridge';

const connectionSchema = z.object({
  id: z.string(),
  provider: z.enum(['google', 'outlook']),
  accountEmail: z.string(),
  lastSyncAt: z.number().nullable(),
  upcoming: z.number(),
  needsReconnect: z.boolean(),
});
const statusSchema = z.object({
  available: z.object({ google: z.boolean(), outlook: z.boolean() }),
  connections: z.array(connectionSchema),
});
export type CalendarConnection = z.infer<typeof connectionSchema>;
export type CalendarStatus = z.infer<typeof statusSchema>;

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
  const parsed = statusSchema.safeParse(await call('GET'));
  if (!parsed.success) throw new Error('eavesy.com sent an answer Eavesy couldn’t read.');
  return parsed.data;
}

export async function disconnectCalendar(id: string): Promise<void> {
  await call('DELETE', { id });
}

/** Google's consent screen runs in the browser; the Mac app opens it there and checks again when you come back. */
export async function connectGoogle(): Promise<void> {
  if (isDesktop()) await openWebApp('/connect-google#mac');
  else window.location.assign('/api/connections/google');
}
