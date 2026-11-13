'use client';

import { CalendarDays } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AppAlert, appButton } from '@/components/ui/app-page';
import { disconnectCalendar, getCalendarStatus, NOT_REVOKED, syncFailingLine, type CalendarStatus } from '@/lib/api/calendar';
import { IntegrationCard } from './integration-card';

const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google wasn’t connected: the Google screen was closed or cancelled.',
  google_no_calendar: 'Google was connected without calendar access. Connect again and leave the calendar box ticked.',
  google_expired: 'That Google sign-in took too long. Connect again.',
  google_unavailable: 'Google isn’t set up on this Eavesy server yet.',
  google_failed: 'Couldn’t connect Google. Try again.',
};

/** The notice for `?connected=google` or `?error=google_…`, pointing back to the Mac app when it started there. */
export function googleOutcome(params: URLSearchParams): { kind: 'ok' | 'error'; text: string } | null {
  const back = params.get('from') === 'mac' ? ' You can go back to the Eavesy app.' : '';
  if (params.get('connected') === 'google') return { kind: 'ok', text: `Google Calendar connected.${back}` };
  const error = params.get('error');
  if (error && Object.hasOwn(GOOGLE_ERRORS, error)) return { kind: 'error', text: GOOGLE_ERRORS[error] + back };
  return null;
}

/** Google Calendar: Connect, or each linked account with Disconnect. */
export function GoogleCalendarCards({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The connection Google couldn't be told about, so Disconnect kept it. */
  const [stuck, setStuck] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    // A failed load is shown on the card itself, with its own retry.
    void getCalendarStatus().then(setStatus).catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);

  const icon = <CalendarDays />;
  // Also shown above the cards when a later reload fails, since those may then be out of date.
  const loadFailed = failed ? (
    <IntegrationCard
      icon={icon}
      name="Google Calendar"
      blurb={status ? 'Could not refresh, so this may be out of date' : 'Could not load your calendar connections'}
      status={{ text: 'Error', tone: 'warn' }}
      action={<button type="button" onClick={load} className={appButton('secondary', 'sm')}>Try again</button>}
    />
  ) : null;
  if (!status) return loadFailed ?? <IntegrationCard icon={icon} name="Google Calendar" blurb="Checking…" />;

  const google = status.connections.filter((connection) => connection.provider === 'google');
  const disconnect = (id: string, force = false) => {
    setBusy(id);
    setStuck(null);
    void disconnectCalendar(id, force)
      .then((done) => { if (done) load(); else setStuck(id); })
      .catch(() => onError('Could not disconnect Google.'))
      .finally(() => setBusy(null));
  };

  return (
    <>
      {loadFailed}
      {google.map((connection) => (
        <IntegrationCard
          key={connection.id}
          icon={icon}
          name="Google Calendar"
          status={connection.needsReconnect
            ? { text: 'Reconnect', tone: 'warn' }
            : connection.syncFailing ? { text: 'Not syncing', tone: 'warn' } : { text: 'Connected', tone: 'on' }}
          blurb={connection.needsReconnect
            ? `${connection.accountEmail} · Google stopped sharing this calendar`
            : connection.syncFailing
              ? `${connection.accountEmail} · ${syncFailingLine(connection.lastSyncAt, Date.now())}`
              : `${connection.accountEmail} · ${connection.upcoming} upcoming ${connection.upcoming === 1 ? 'meeting' : 'meetings'}`}
          action={connection.needsReconnect ? (
            <a href="/api/connections/google" className={appButton('primary', 'sm')}>Reconnect</a>
          ) : (
            <button type="button" disabled={busy === connection.id} onClick={() => disconnect(connection.id)} className={appButton('ghost', 'sm')}>
              {busy === connection.id ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
        >
          {stuck === connection.id ? (
            <AppAlert tone="danger">
              <p className="text-xs">{NOT_REVOKED}</p>
              <span className="mt-2 flex gap-2">
                <button type="button" onClick={() => disconnect(connection.id)} className={appButton('secondary', 'sm')}>Try again</button>
                <button type="button" onClick={() => disconnect(connection.id, true)} className={appButton('ghost', 'sm')}>Remove anyway</button>
              </span>
            </AppAlert>
          ) : null}
        </IntegrationCard>
      ))}
      {status.available.google || google.length === 0 ? (
        <IntegrationCard
          icon={icon}
          name={google.length ? 'Another Google account' : 'Google Calendar'}
          blurb={status.available.google ? 'See upcoming meetings and record them automatically' : 'Not set up on this Eavesy server'}
          action={status.available.google ? (
            <a href="/api/connections/google" className={appButton(google.length ? 'secondary' : 'primary', 'sm')}>Connect</a>
          ) : null}
        />
      ) : null}
    </>
  );
}
