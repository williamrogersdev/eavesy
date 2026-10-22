import { createFileRoute } from '@tanstack/react-router';
import { Bot } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { z } from 'zod';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppEmptyState, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';

export const Route = createFileRoute('/app/notetaker')({ component: NotetakerPage });

const botSchema = z.object({
  id: z.string(),
  meetingId: z.string().nullable(),
  meetingUrl: z.string(),
  platform: z.enum(['zoom', 'meet', 'teams']),
  title: z.string().nullable(),
  joinAt: z.number().nullable(),
  status: z.string(),
  statusDetail: z.string().nullable(),
  createdAt: z.number(),
});
const listSchema = z.object({ available: z.boolean(), bots: z.array(botSchema) });
const errorSchema = z.object({ error: z.string().optional(), warning: z.string().optional() });
type MeetingBot = z.infer<typeof botSchema>;

const PLATFORM: Record<MeetingBot['platform'], string> = { zoom: 'Zoom', meet: 'Google Meet', teams: 'Teams' };
const STATUS: Record<string, string> = {
  scheduling: 'Sending…',
  scheduled: 'Scheduled',
  joining: 'Joining',
  waiting_room: 'In the waiting room',
  in_call: 'In the meeting, not recording yet',
  recording: 'Recording',
  call_ended: 'Call ended',
  collecting: 'Writing up',
  done: 'Done',
  failed: 'Did not record',
  cancelled: 'Cancelled',
};
const FAILURE: Record<string, string> = {
  bot_kicked_from_waiting_room: 'It was not admitted from the waiting room.',
  timeout_exceeded_waiting_room: 'Nobody admitted it from the waiting room.',
  timeout_exceeded_noone_joined: 'Nobody joined the meeting.',
  meeting_not_found: 'The link did not lead to a meeting.',
  sign_in_required: 'The meeting only admits signed-in accounts.',
  join_failed: 'It could not find its way into the meeting.',
  bot_removed: 'It was removed from the meeting.',
  bot_error: 'It stopped with an error.',
  bot_never_reported: 'It did not start.',
  lost_track: 'It stopped reporting before the meeting finished.',
  provider_unavailable: 'The notetaker service was unavailable.',
  provider_retired: 'It was sent through a service Eavesy no longer uses.',
};
const ACTIVE = new Set(['scheduling', 'scheduled', 'joining', 'waiting_room', 'in_call', 'recording', 'call_ended', 'collecting']);
const IN_CALL = new Set(['joining', 'waiting_room', 'in_call', 'recording']);

const LOAD_ERROR = 'Could not load your notetakers. Refresh to retry.';

/** The server's `{ error, warning }` body, or nothing when it isn't one. */
async function messageOf(response: Response) {
  const parsed = errorSchema.safeParse(await response.json().catch(() => ({})));
  return parsed.success ? parsed.data : {};
}

const field = 'h-10 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm text-ev-ink outline-none transition-colors placeholder:text-ev-ink-3 focus:border-ev-coat';
const label = 'font-round text-[13px] font-bold text-ev-ink';

function when(bot: MeetingBot) {
  const at = new Date(bot.joinAt ?? bot.createdAt);
  return at.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function NotetakerPage() {
  const ids = useId();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [bots, setBots] = useState<MeetingBot[]>([]);
  const [meetingUrl, setMeetingUrl] = useState('');
  const [title, setTitle] = useState('');
  const [startAt, setStartAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/meeting-bots/');
      if (!response.ok) throw new Error('load failed');
      const data = listSchema.parse(await response.json());
      setAvailable(data.available);
      setBots(data.bots);
      setError((current) => (current === LOAD_ERROR ? '' : current));
    } catch {
      setError(LOAD_ERROR);
    }
  }, []);

  const anyActive = bots.some((bot) => ACTIVE.has(bot.status));
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [anyActive, load]);

  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const joinAt = startAt ? new Date(startAt).getTime() : null;
      const response = await fetch('/api/meeting-bots/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingUrl, title: title || null, joinAt }),
      });
      const body = await messageOf(response);
      if (!response.ok) {
        setError(body.error ?? 'The notetaker could not be sent. Please retry.');
        return;
      }
      setNotice(body.warning ?? (joinAt ? 'Scheduled. It joins at the start time.' : 'On its way. Admit “Eavesy Notetaker” if the meeting has a waiting room.'));
      setMeetingUrl('');
      setTitle('');
      setStartAt('');
      await load();
    } catch {
      setError('The notetaker could not be sent. Check your connection and retry.');
    } finally {
      setBusy(false);
    }
  }

  async function stop(bot: MeetingBot) {
    setError('');
    try {
      const response = await fetch(`/api/meeting-bots/${bot.id}`, { method: 'DELETE' });
      if (!response.ok) setError((await messageOf(response)).error ?? 'Could not stop the notetaker.');
    } catch {
      setError('Could not stop the notetaker. Check your connection and retry.');
    } finally {
      await load();
    }
  }

  return (
    <AppPage width="compact">
      <AppPageHeader
        title="Notetaker"
        description="Send a notetaker to a Google Meet or Teams call you can't record from your Mac. It joins as a participant, the transcript fills in as the call goes, and the brief lands in your library when it ends."
      />
      {error ? <AppAlert>{error}</AppAlert> : null}
      {notice ? <AppAlert tone="success">{notice}</AppAlert> : null}

      {available === false ? (
        <AppEmptyState
          icon={<Bot />}
          title="Notetaker isn't set up here"
          description="This Eavesy server doesn't run the meeting bot. Record calls with the Mac app instead."
        />
      ) : (
        <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5" htmlFor={`${ids}-url`}>
            <span className={label}>Meeting link</span>
            <input
              id={`${ids}-url`}
              type="url"
              required
              value={meetingUrl}
              onChange={(event) => setMeetingUrl(event.target.value)}
              placeholder="https://meet.google.com/abc-defg-hij  or a Teams link"
              autoComplete="off"
              className={field}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5" htmlFor={`${ids}-title`}>
              <span className={label}>
                Title <span className="font-sans text-[12px] font-normal text-ev-ink-2">optional</span>
              </span>
              <input
                id={`${ids}-title`}
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Weekly sync"
                className={field}
              />
            </label>
            <label className="flex flex-col gap-1.5" htmlFor={`${ids}-at`}>
              <span className={label}>
                Start time <span className="font-sans text-[12px] font-normal text-ev-ink-2">empty joins now</span>
              </span>
              <input
                id={`${ids}-at`}
                type="datetime-local"
                value={startAt}
                onChange={(event) => setStartAt(event.target.value)}
                className={field}
              />
            </label>
          </div>
          <p className="text-[13px] text-ev-ink-2">
            Everyone in the call sees “Eavesy Notetaker” join. Let them know it records, and follow the recording-consent rules where you and they are.
          </p>
          <div>
            <button type="submit" disabled={busy || available === null} className={appButton('primary')}>
              <Bot className="h-4 w-4" strokeWidth={2} />
              {busy ? 'Sending…' : startAt ? 'Schedule notetaker' : 'Send notetaker now'}
            </button>
          </div>
        </form>
      )}

      {bots.length > 0 ? (
        <AppSection title="Your notetakers">
          <ul className="flex flex-col gap-2">
            {bots.map((bot) => (
              <li key={bot.id} className="flex flex-col gap-1 rounded-[var(--ev-r-panel)] bg-ev-well px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-round text-sm font-bold text-ev-ink">
                    {bot.title || `${PLATFORM[bot.platform]} meeting`}
                  </p>
                  <p className="text-[13px] text-ev-ink-2">
                    {when(bot)} · {STATUS[bot.status] ?? bot.status}
                    {bot.status === 'failed' && bot.statusDetail && FAILURE[bot.statusDetail] ? ` · ${FAILURE[bot.statusDetail]}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {bot.meetingId ? (
                    <Link href={`/app/meetings/${bot.meetingId}`} className={appButton('secondary', 'sm')}>Open</Link>
                  ) : null}
                  {bot.status === 'scheduled' || bot.status === 'scheduling' ? (
                    <button type="button" onClick={() => void stop(bot)} className={appButton('ghost', 'sm')}>Cancel</button>
                  ) : IN_CALL.has(bot.status) ? (
                    <button type="button" onClick={() => void stop(bot)} className={appButton('ghost', 'sm')}>Make it leave</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </AppSection>
      ) : null}
    </AppPage>
  );
}
