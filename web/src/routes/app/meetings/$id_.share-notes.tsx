import { createFileRoute } from '@tanstack/react-router';
import { ChevronLeft, Mail, Plus, Send } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';
import { isRecord } from '@/lib/json';
import { cn } from '@/lib/utils';

/**
 * "Send to everyone": the page the button in a recap email opens. Opening it
 * sends nothing (mail scanners open links); the owner reviews who gets the
 * notes and presses Send, which POSTs.
 */
export const Route = createFileRoute('/app/meetings/$id_/share-notes')({
  head: () => ({ meta: [{ title: 'Send notes · Eavesy' }, { name: 'robots', content: 'noindex, nofollow' }] }),
  component: ShareNotesPage,
});

interface Person {
  email: string | null;
  name: string | null;
  source: 'calendar' | 'speaker' | 'added';
  external: boolean;
  allowed: boolean;
  suppressed: boolean;
  status: string | null;
}

interface Overview {
  configured: boolean;
  meeting: { id: string; title: string; startedAt: number | null; status: string };
  owner: { email: string | null; name: string | null; companyDomain: string | null };
  settings: { offer: boolean; scope: 'everyone' | 'domain'; includeTranscript: boolean };
  preview: { tldr: string; decisions: string[]; actionItems: { text: string; owner: string | null; due: string | null }[] };
  attendees: Person[];
}

type Outcome = 'queued' | 'already_sent' | 'suppressed' | 'not_allowed' | 'invalid' | 'owner' | 'daily_limit' | 'needs_confirmation' | 'too_many_added';
const OUTCOME_LABEL: Record<Outcome, string> = {
  queued: 'Sending',
  already_sent: 'Already had it',
  suppressed: 'Skipped: this address can’t be reached',
  not_allowed: 'Skipped: outside your company’s domain',
  invalid: 'Skipped: not an email address',
  owner: 'Skipped: that’s you',
  daily_limit: 'Skipped: you’ve reached today’s limit of people to email',
  needs_confirmation: 'Skipped: not in the meeting, and not confirmed',
  too_many_added: 'Skipped: at most 10 people from outside the meeting per send',
};

/** A delivery in one of these states has, or may have, reached them: never sent again. */
const HAS_NOTES = new Set(['queued', 'unknown', 'sent', 'delivered']);
const hasNotes = (status: string | null) => status !== null && HAS_NOTES.has(status);

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const input = 'h-9 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat';

function domainOf(email: string) {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

function ShareNotesPage() {
  const { id } = Route.useParams();
  const [data, setData] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Addresses typed in for named speakers, keyed by row. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ email: string; outcome: Outcome }[] | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/share-notes`);
    if (!response.ok) throw new Error(response.status === 404 ? 'We couldn’t find that meeting.' : `Server returned ${response.status}`);
    const value = await response.json<Overview>();
    setData(value);
    return value;
  }, [id]);

  useEffect(() => {
    void load()
      .then((value) => {
        // Everyone who can get it and doesn't have it yet starts ticked.
        setSelected(new Set(value.attendees
          .filter((p) => p.email && p.allowed && !p.suppressed && !hasNotes(p.status))
          .map((p) => p.email!)));
      })
      .catch((cause: unknown) => setLoadError(cause instanceof Error ? cause.message : 'Could not load this meeting.'));
  }, [load]);

  const ownerDomain = data?.owner.email ? domainOf(data.owner.email) : null;
  const allowed = useCallback((email: string) => {
    if (!data || data.settings.scope === 'everyone') return true;
    return data.owner.companyDomain !== null && domainOf(email) === data.owner.companyDomain;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const listed: (Person & { key: string; address: string | null })[] = data.attendees.map((p, i) => {
      const key = p.email ?? `speaker:${i}`;
      const entered = typed[key]?.trim() ?? '';
      const address = p.email ?? (EMAIL.test(entered) ? entered.toLowerCase() : null);
      return {
        ...p,
        key,
        address,
        external: address ? domainOf(address) !== ownerDomain : false,
        allowed: address ? allowed(address) : true,
      };
    });
    for (const email of added) {
      if (listed.some((p) => p.address === email)) continue;
      listed.push({ email, name: null, source: 'added', external: domainOf(email) !== ownerDomain, allowed: allowed(email), suppressed: false, status: null, key: email, address: email });
    }
    return listed;
  }, [data, typed, added, ownerDomain, allowed]);

  const recipients = rows.filter((r) => r.address && selected.has(r.key) && r.allowed && !r.suppressed && !hasNotes(r.status)).map((r) => r.address!);

  const toggle = (key: string, on: boolean) => setSelected((current) => {
    const next = new Set(current);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  });

  const addPerson = () => {
    const email = draft.trim().toLowerCase();
    if (!EMAIL.test(email)) {
      setError('That doesn’t look like an email address.');
      return;
    }
    if (email === data?.owner.email) {
      setError('That’s your own address: you already get these notes.');
      return;
    }
    setError(null);
    setAdded((current) => (current.includes(email) ? current : [...current, email]));
    toggle(email, true);
    setDraft('');
  };

  const send = async () => {
    // People who weren't on the invite are confirmed once more before anything goes to them.
    const invited = new Set(data?.attendees.filter((a) => a.source === 'calendar').map((a) => a.email));
    const outside = recipients.filter((email) => !invited.has(email));
    if (outside.length && !window.confirm(`${outside.length === 1 ? `${outside[0]} wasn’t` : `${outside.length} people weren’t`} on the meeting invite. Send them the notes too?`)) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/meetings/${encodeURIComponent(id)}/share-notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipients, note: note.trim() || null, confirmAdded: outside.length > 0 }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(isRecord(body) && typeof body.error === 'string' && !/^[a-z_]+$/.test(body.error)
          ? body.error
          : response.status === 429 ? 'Too many sends just now. Try again in a minute.' : `Server returned ${response.status}`);
      }
      setResults(isRecord(body) && Array.isArray(body.results) ? body.results as { email: string; outcome: Outcome }[] : []);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the notes.');
    } finally {
      setSending(false);
    }
  };

  const back = (
    <Link
      href={`/app/meetings/${encodeURIComponent(id)}`}
      className="inline-flex items-center gap-1 rounded-full py-1 pr-2 font-round text-[13px] font-semibold text-ev-ink-2 hover:text-ev-ink"
    >
      <ChevronLeft className="h-4 w-4" /> Back to the meeting
    </Link>
  );

  if (loadError) return <AppPage width="compact">{back}<AppAlert>{loadError}</AppAlert></AppPage>;
  if (!data) return <AppPage width="compact">{back}<p className="text-sm text-ev-ink-2">Loading…</p></AppPage>;

  const notReady = data.meeting.status !== 'complete';
  const domainOnlyWithoutDomain = data.settings.scope === 'domain' && !data.owner.companyDomain;

  return (
    <AppPage width="compact">
      {back}
      <AppPageHeader
        title="Send the notes to everyone"
        description={`${data.meeting.title}. Nothing is sent until you press Send.`}
      />

      {!data.configured ? <AppAlert>Email is not set up on this server.</AppAlert> : null}
      {notReady ? <AppAlert tone="info">The notes aren’t ready yet. Come back when the meeting has finished processing.</AppAlert> : null}
      {domainOnlyWithoutDomain ? (
        <AppAlert tone="info">
          Your settings only allow your company’s domain, and your address is a personal one, so nobody can get these notes.{' '}
          <Link href="/app/settings#email" className="underline">Change who can receive them</Link>.
        </AppAlert>
      ) : data.settings.scope === 'domain' ? (
        <AppAlert tone="info">Only people at {data.owner.companyDomain} can get these notes (Settings → Email).</AppAlert>
      ) : null}
      {results ? (
        <AppAlert tone="success">
          <p className="font-semibold">
            {results.filter((r) => r.outcome === 'queued').length
              ? `Sending to ${results.filter((r) => r.outcome === 'queued').length} ${results.filter((r) => r.outcome === 'queued').length === 1 ? 'person' : 'people'}.`
              : 'Nobody new to send to.'}
          </p>
          <ul className="mt-1 space-y-0.5">
            {results.map((r) => <li key={r.email}>{r.email}: {OUTCOME_LABEL[r.outcome] ?? r.outcome}</li>)}
          </ul>
        </AppAlert>
      ) : null}
      {error ? <AppAlert>{error}</AppAlert> : null}

      <AppSection title="Who gets it" description={data.attendees.some((a) => a.source === 'calendar') ? 'From the calendar invite.' : data.attendees.length ? 'There was no calendar invite, so these are the speakers you named. Add their addresses.' : 'There was no calendar invite. Add people by email.'}>
        <ul className="flex flex-col divide-y divide-ev-line">
          {rows.map((row) => {
            const done = hasNotes(row.status);
            // An earlier send that certainly failed can be tried again.
            const failedBefore = row.status !== null && !done;
            const blocked = !row.allowed || row.suppressed;
            const rowId = `share-${row.key}`;
            return (
              <li key={row.key} className="flex items-center gap-3 py-2.5">
                <input
                  id={rowId}
                  type="checkbox"
                  checked={!done && !blocked && Boolean(row.address) && selected.has(row.key)}
                  disabled={done || blocked || !row.address}
                  onChange={(e) => toggle(row.key, e.target.checked)}
                />
                <label htmlFor={rowId} className="min-w-0 flex-1 text-sm">
                  <span className="block truncate text-ev-ink">{row.name ?? row.address ?? 'Unnamed speaker'}</span>
                  {row.email && row.name ? <span className="block truncate text-xs text-ev-ink-2">{row.email}</span> : null}
                </label>
                {row.source === 'speaker' ? (
                  <input
                    type="email"
                    aria-label={`Email address for ${row.name ?? 'this speaker'}`}
                    placeholder="name@company.com"
                    value={typed[row.key] ?? ''}
                    onChange={(e) => {
                      const value = e.target.value;
                      setTyped((current) => ({ ...current, [row.key]: value }));
                      if (EMAIL.test(value.trim())) toggle(row.key, true);
                    }}
                    className={cn(input, 'w-48 shrink-0')}
                  />
                ) : null}
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {row.address && row.external ? <Tag tone="warn">External</Tag> : null}
                  {done ? <Tag>{row.status === 'queued' ? 'Sending' : 'Already sent'}</Tag> : null}
                  {failedBefore && !blocked ? <Tag>Didn’t go through before</Tag> : null}
                  {!done && row.suppressed ? <Tag>Can’t be reached</Tag> : null}
                  {!done && !row.suppressed && !row.allowed ? <Tag>Not allowed</Tag> : null}
                </span>
              </li>
            );
          })}
          {!rows.length ? <li className="py-2.5 text-sm text-ev-ink-2">No attendees found for this meeting.</li> : null}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            addPerson();
          }}
        >
          <input
            type="email"
            aria-label="Add someone by email"
            placeholder="Add someone by email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className={input}
          />
          <button type="submit" className={appButton('secondary')} disabled={!draft.trim()}>
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </form>
      </AppSection>

      <AppSection title="Add a note" description="Optional. It goes at the top of the email.">
        <textarea
          aria-label="Note to attendees"
          value={note}
          maxLength={2000}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Thanks all, here's what we agreed."
          className="w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 py-2 text-sm outline-none focus:border-ev-coat"
        />
      </AppSection>

      <AppSection
        title="Preview"
        description={data.settings.includeTranscript
          ? 'The transcript is attached, because “Include the transcript” is on in Settings → Email.'
          : 'The transcript is not attached. Recipients get a link to these notes.'}
      >
        <div className="rounded-[var(--ev-r-panel)] bg-ev-well px-4 py-3 text-sm text-ev-ink">
          <p className="flex items-center gap-1.5 text-xs text-ev-ink-2"><Mail className="h-3.5 w-3.5" /> Notes: {data.meeting.title}</p>
          {note.trim() ? <p className="mt-3 whitespace-pre-wrap">{note.trim()}</p> : null}
          <h3 className="mt-3 font-semibold">Summary</h3>
          <p>{data.preview.tldr || 'No summary was written for this meeting.'}</p>
          {data.preview.actionItems.length ? (
            <>
              <h3 className="mt-3 font-semibold">Action items</h3>
              <ul className="list-disc pl-5">
                {data.preview.actionItems.map((a, i) => (
                  <li key={i}>{a.text}{a.owner || a.due ? <span className="text-ev-ink-2"> ({[a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', ')})</span> : null}</li>
                ))}
              </ul>
            </>
          ) : null}
          {data.preview.decisions.length ? (
            <>
              <h3 className="mt-3 font-semibold">Decisions</h3>
              <ul className="list-disc pl-5">{data.preview.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
            </>
          ) : null}
          <p className="mt-3 text-ev-ink-2 underline">Open the full notes</p>
        </div>
      </AppSection>

      <div className="flex items-center justify-end gap-3">
        <span className="text-sm text-ev-ink-2">
          {recipients.length ? `${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}` : 'Nobody selected'}
        </span>
        <button
          type="button"
          className={appButton('primary')}
          disabled={sending || !recipients.length || !data.configured || notReady}
          onClick={() => void send()}
        >
          <Send className="h-3.5 w-3.5" /> {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </AppPage>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <span className={cn(
      'inline-flex h-5 items-center rounded-full px-2 font-round text-[11px] font-semibold',
      tone === 'warn' ? 'bg-ev-manila-soft text-ev-manila-ink' : 'bg-ev-well text-ev-ink-2',
    )}
    >
      {children}
    </span>
  );
}
