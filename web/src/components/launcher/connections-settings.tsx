'use client';

import { Asterisk, Check, ChevronDown, ChevronUp, Copy, MessageCircle, Plug, SquareTerminal, Terminal, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Card, Menu, Segmented, Switch } from '@/components/launcher/ui';
import {
  connectGoogle,
  disconnectCalendar,
  getCalendarStatus,
  getUpcomingMeetings,
  NOT_REVOKED,
  setRecordChoice,
  type CalendarStatus,
  type UpcomingMeeting,
} from '@/lib/api/calendar';
import { listMcpTokens, revokeMcpToken } from '@/lib/api/mcp-tokens';
import {
  claudeCodeStatus,
  connectClaudeCode,
  copyText,
  errMsg,
  isDesktop,
  openWebApp,
  signInClaudeCode,
  type ClaudeCodeStatus,
} from '@/lib/desktop/bridge';
import {
  CLAUDE_CODE_ADD,
  CLAUDE_CODE_AGENT_PROMPT,
  CLAUDE_CODE_PLUGIN_CLI,
  CLAUDE_CODE_SIGN_IN,
  isClaudeCodeToken,
  MCP_AGENT_PROMPT,
  MCP_URL,
  type McpToken,
} from '@/lib/mcp-tokens';
import { claudeCodeConnected, claudeCodeStage, type ClaudeCodeStage } from './connections-model';

/** Text to copy (a URL, a command or a whole prompt), with a Copy button that says when it worked. */
function CopyField({ label, text, block = false }: { label: string; text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="ev-conn-copy" data-block={block || undefined}>
      <code aria-label={label}>{text}</code>
      <Button
        variant="outline"
        size="sm"
        icon={copied ? Check : Copy}
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => void copyText(text).then(() => setCopied(true)).catch(() => {})}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** Numbered steps. A step marked `done` shows a tick in place of its number. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="ev-conn-steps">{children}</ol>;
}

function Step({ title, done = false, children }: { title: ReactNode; done?: boolean; children?: ReactNode }) {
  return (
    <li data-done={done || undefined}>
      <p className="ev-conn-step-title">{title}</p>
      {children}
    </li>
  );
}

/** "Set up ▾" opens an app's steps; "Close ▴" folds them away again. */
function SetupToggle({ open, onToggle, name, controls, label = 'Set up' }: { open: boolean; onToggle: () => void; name: string; controls: string; label?: string }) {
  return (
    <Button
      variant={open ? 'ghost' : 'outline'}
      size="sm"
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Close ${name} setup` : `${label}: ${name}`}
      onClick={onToggle}
    >
      {open ? 'Close' : label}
      {open ? <ChevronUp size={13} strokeWidth={1.75} aria-hidden /> : <ChevronDown size={13} strokeWidth={1.75} aria-hidden />}
    </Button>
  );
}

/** Runs `refresh` again whenever you come back to this window, e.g. from approving in the browser. */
function useOnReturn(active: boolean, refresh: () => void) {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [active, refresh]);
}

/** Google's own mark: the one place its colours appear. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

/** One connection: a mark, its name and account, and what you can do with it on the right. */
function AppRow({ mark, name, detail, action, panelId, children }: { mark: ReactNode; name: string; detail?: ReactNode; action?: ReactNode; panelId?: string; children?: ReactNode }) {
  return (
    <div className="ev-conn-row">
      <div className="ev-conn-head">
        <span className="ev-conn-mark" aria-hidden>{mark}</span>
        <div className="min-w-0 flex-1">
          <p className="ev-set-label truncate">{name}</p>
          {detail && <p className="ev-set-hint">{detail}</p>}
        </div>
        {action}
      </div>
      {children && <div className="ev-conn-more" id={panelId}>{children}</div>}
    </div>
  );
}

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return <Icon size={16} strokeWidth={1.75} />;
}

/** "✓ Connected ▾": the connected state, whose menu holds Disconnect. */
function ConnectedMenu({ label, busy, items }: { label: string; busy: boolean; items: { label: string; onSelect: () => void; tone?: 'warn' }[] }) {
  return (
    <Menu
      align="end"
      items={items}
      trigger={
        <Button variant="outline" size="sm" icon={Check} loading={busy} aria-label={label}>
          Connected
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
        </Button>
      }
    />
  );
}

function syncedLine(upcoming: number): string {
  if (upcoming === 0) return 'Calendar · no meetings in the next two weeks';
  return `Calendar · ${upcoming} ${upcoming === 1 ? 'meeting' : 'meetings'} in the next two weeks`;
}

const WAIT_POLL_MS = 3000;
const WAIT_LIMIT_MS = 5 * 60 * 1000;
/** Longer than the app's own 10s limit on asking Claude Code. */
const ASK_LIMIT_MS = 20_000;

/** Google Calendar: connect in one click, then the account, what's used, and Disconnect. */
function Accounts({ signedIn, active }: { signedIn: boolean; active: boolean }) {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The connection Google couldn't be told about, so Disconnect kept it. */
  const [stuck, setStuck] = useState<string | null>(null);
  const load = useCallback(() => {
    void getCalendarStatus()
      .then((next) => { setStatus(next); setError(null); })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t check your accounts.')));
  }, []);
  useEffect(() => { if (signedIn && active) load(); }, [signedIn, active, load]);
  const google = status?.connections.filter((c) => c.provider === 'google') ?? [];
  // While Google's screen is open in the browser, look again every few seconds and on coming back.
  useEffect(() => {
    if (waiting === null) return;
    const timer = setInterval(() => {
      if (Date.now() - waiting > WAIT_LIMIT_MS) setWaiting(null);
      else load();
    }, WAIT_POLL_MS);
    // Coming back to this window means the browser part is over, whichever way it went.
    const back = () => { load(); setWaiting(null); };
    window.addEventListener('focus', back);
    return () => { clearInterval(timer); window.removeEventListener('focus', back); };
  }, [waiting, load]);
  // Any new account, or a change to one (a reconnect syncs it again), means Google sent you back.
  const snapshot = JSON.stringify(status?.connections.map((c) => [c.id, c.lastSyncAt, c.needsReconnect]) ?? []);
  const [before, setBefore] = useState(snapshot);
  useEffect(() => { if (waiting !== null && snapshot !== before) setWaiting(null); }, [waiting, snapshot, before]);

  if (!signedIn) {
    return (
      <AppRow mark={<GoogleMark />} name="Google Calendar" detail="Sign in to Eavesy first. Your calendar links to your account, not this Mac." />
    );
  }
  const connect = () => {
    setError(null);
    setBefore(snapshot);
    void connectGoogle()
      .then(() => { if (isDesktop()) setWaiting(Date.now()); })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t open Google.')));
  };
  const disconnect = (id: string, force = false) => {
    setBusy(id);
    setError(null);
    setStuck(null);
    void disconnectCalendar(id, force)
      .then((done) => { if (done) load(); else setStuck(id); })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t disconnect Google.')))
      .finally(() => setBusy(null));
  };
  const unavailable = status !== null && !status.available.google;
  const connectButton = waiting !== null
    ? <Button variant="ghost" size="sm" onClick={() => setWaiting(null)}>Cancel</Button>
    : <Button variant="primary" size="sm" disabled={status === null || unavailable} onClick={connect}>Connect</Button>;

  return (
    <>
      {google.map((connection) => (
        <AppRow
          key={connection.id}
          mark={<GoogleMark />}
          name="Google Calendar"
          detail={
            <>
              <span className="block truncate">{connection.accountEmail}</span>
              {connection.needsReconnect
                ? <span className="ev-conn-warn">Google stopped sharing this calendar. Connect it again.</span>
                : syncedLine(connection.upcoming)}
            </>
          }
          action={
            connection.needsReconnect
              ? <Button variant="primary" size="sm" onClick={connect}>Reconnect</Button>
              : (
                <ConnectedMenu
                  label={`Google Calendar, ${connection.accountEmail}: connected`}
                  busy={busy === connection.id}
                  items={[
                    { label: 'Add another Google account', onSelect: connect },
                    { label: 'Disconnect', tone: 'warn', onSelect: () => disconnect(connection.id) },
                  ]}
                />
              )
          }
        />
      ))}
      {(google.length === 0 || waiting !== null) && (
        <AppRow
          mark={<GoogleMark />}
          name="Google Calendar"
          detail={
            waiting !== null
              ? 'Waiting for you in the browser…'
              : unavailable
                ? 'Google isn’t set up on this Eavesy server yet.'
                : 'Read-only access to your upcoming meetings.'
          }
          action={connectButton}
        />
      )}
      {stuck && (
        <div className="ev-set-row">
          <p role="alert" className="ev-set-hint min-w-0 flex-1">{NOT_REVOKED}</p>
          <Button variant="outline" size="sm" onClick={() => disconnect(stuck)}>Try again</Button>
          <Button variant="ghost" size="sm" onClick={() => disconnect(stuck, true)}>Remove anyway</Button>
        </div>
      )}
      {error && (
        <div className="ev-set-row">
          <p role="alert" className="ev-set-hint min-w-0 flex-1">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      )}
    </>
  );
}

function meetingTime(meeting: UpcomingMeeting, now: number): string {
  const start = new Date(meeting.startsAt);
  const time = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (meeting.startsAt <= now) return `Now, until ${new Date(meeting.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return start.toDateString() === new Date(now).toDateString() ? `Today ${time}` : `Tomorrow ${time}`;
}

/**
 * The next day's meetings, each with whether Eavesy records it when its call
 * starts. A switch left as the "record all" setting says stores nothing, so
 * changing that setting moves every meeting you didn't choose for.
 */
function UpcomingMeetings({ autoRecord, active }: { autoRecord: boolean; active: boolean }) {
  // undefined while loading, null when no calendar is connected.
  const [meetings, setMeetings] = useState<UpcomingMeeting[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!active) return;
    void getUpcomingMeetings()
      .then((next) => { setMeetings(next); setError(null); })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your meetings.')));
  }, [active]);
  if (error) return <p role="alert" className="ev-set-hint">{error}</p>;
  if (meetings === undefined) return null;
  if (meetings === null) return <p className="ev-set-hint">Connect a calendar above to choose meeting by meeting.</p>;
  if (meetings.length === 0) return <p className="ev-set-hint">No meetings in the next day.</p>;
  const now = Date.now();
  const choose = (meeting: UpcomingMeeting, record: boolean) => {
    const choice = record === autoRecord ? null : record ? 'record' : 'skip';
    setBusy(meeting.id);
    setError(null);
    void setRecordChoice(meeting.id, choice)
      .then(() => setMeetings((current) => current?.map((m) => m.id === meeting.id ? { ...m, recordChoice: choice } : m) ?? current))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t save that. Try again.')))
      .finally(() => setBusy(null));
  };
  return (
    <>
      {meetings.map((meeting) => (
        <Switch
          key={meeting.id}
          checked={meeting.recordChoice === null ? autoRecord : meeting.recordChoice === 'record'}
          onCheckedChange={(record) => choose(meeting, record)}
          disabled={busy === meeting.id}
          label={meeting.title}
          hint={meetingTime(meeting, now)}
        />
      ))}
    </>
  );
}

/** Picks a mark for an MCP app from the name it signed in with. */
function markFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (isClaudeCodeToken({ name })) return SquareTerminal;
  if (n.includes('claude')) return Asterisk;
  if (n.includes('chatgpt') || n.includes('openai')) return MessageCircle;
  return Plug;
}

function usedLine(token: McpToken): string {
  const access = token.canWrite ? 'Read & write' : 'Read-only';
  const used = token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleDateString()}` : 'not used yet';
  const expired = token.expiresAt !== null && token.expiresAt <= Date.now();
  return `${access} · ${used}${expired ? ' · expired, sign in again from the app' : ''}`;
}

/** The account's MCP sign-ins, loaded once for both lists so they agree. */
function useMcpTokens(signedIn: boolean, active: boolean) {
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void listMcpTokens()
      .then(setTokens)
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your connected apps.')));
  }, []);
  // Reloaded each time the page is shown or you come back to it, so an app approved a moment ago appears.
  useEffect(() => { if (signedIn && active) load(); }, [signedIn, active, load]);
  useOnReturn(signedIn && active, load);
  return { tokens: signedIn ? tokens : null, error, setError, setTokens, load };
}

/** Claude Code on this Mac, as the app sees it. Polled by `ClaudeCodeApp` while you sign in. */
function useClaudeCode(active: boolean) {
  const desktop = isDesktop();
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  // While a button's command runs, its own answer is the one to show.
  const running = useRef(false);
  // One check at a time: the poll and coming back to the window can both ask.
  // A check that never answers stops counting after ASK_LIMIT_MS, so it can't block the rest.
  const asking = useRef<number | null>(null);
  const refresh = useCallback(() => {
    if (!desktop || running.current) return;
    if (asking.current !== null && Date.now() - asking.current < ASK_LIMIT_MS) return;
    const started = Date.now();
    asking.current = started;
    void claudeCodeStatus()
      .then((next) => { if (!running.current) setStatus(next); })
      .catch(() => {})
      .finally(() => { if (asking.current === started) asking.current = null; });
  }, [desktop]);
  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  useOnReturn(desktop && active, refresh);
  return { desktop, status, setStatus, refresh, running };
}

type ClaudeCode = ReturnType<typeof useClaudeCode>;

/** The AI apps signed in to this account over MCP, each one revocable. */
function ConnectedApps({
  signedIn,
  mcp,
  claudeLocal,
  onClaudeSetup,
}: {
  signedIn: boolean;
  mcp: ReturnType<typeof useMcpTokens>;
  /** Claude Code on this Mac says it's signed in. */
  claudeLocal: boolean;
  onClaudeSetup: () => void;
}) {
  const { tokens, error, setError, setTokens, load } = mcp;
  const [revoking, setRevoking] = useState<string | null>(null);
  const claudeHere = (
    <AppRow
      mark={<Glyph icon={SquareTerminal} />}
      name="Claude Code"
      detail="Signed in on this Mac"
      action={<ConnectedMenu label="Claude Code: connected" busy={false} items={[{ label: 'Show the setup steps', onSelect: onClaudeSetup }]} />}
    />
  );
  if (!signedIn) {
    return (
      <>
        {claudeLocal && claudeHere}
        <p className="ev-set-hint">Sign in to see the apps connected to your Eavesy account.</p>
      </>
    );
  }
  const revoke = (id: string) => {
    setRevoking(id);
    setError(null);
    void revokeMcpToken(id)
      .then(() => setTokens((list) => list?.filter((token) => token.id !== id) ?? list))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t disconnect that app.')))
      .finally(() => setRevoking(null));
  };
  // Claude Code here is signed in but its sign-in isn't listed yet (the list is a step behind): show it anyway.
  const claudeOnlyHere = claudeLocal && tokens !== null && !tokens.some(isClaudeCodeToken);
  const empty = tokens?.length === 0 && !claudeOnlyHere;
  return (
    <>
      {tokens === null && !error && <p className="ev-set-hint">Checking…</p>}
      {empty && <p className="ev-set-hint">None yet. Set one up below and it shows up here once it signs in.</p>}
      {claudeOnlyHere && claudeHere}
      {tokens?.map((token) => (
        <AppRow
          key={token.id}
          mark={<Glyph icon={markFor(token.name)} />}
          name={token.name}
          detail={usedLine(token)}
          action={
            <ConnectedMenu
              label={`${token.name}: connected`}
              busy={revoking === token.id}
              items={[
                ...(isClaudeCodeToken(token) ? [{ label: 'Show the setup steps', onSelect: onClaudeSetup }] : []),
                { label: 'Disconnect', tone: 'warn' as const, onSelect: () => revoke(token.id) },
              ]}
            />
          }
        />
      ))}
      {error && (
        <div className="ev-set-row">
          <p role="alert" className="ev-set-hint min-w-0 flex-1">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>Try again</Button>
        </div>
      )}
    </>
  );
}

type ClaudeMethod = 'app' | 'agent' | 'terminal';

/** Have an agent do it: one prompt to paste, and the one part it hands back to you. */
function ClaudeCodeByAgent() {
  return (
    <Steps>
      <Step title="Copy this prompt">
        <CopyField label="Claude Code setup prompt" text={CLAUDE_CODE_AGENT_PROMPT} block />
      </Step>
      <Step title="Paste it into Claude Code">
        <p className="ev-set-hint">Any folder works. It runs the install commands and checks they worked.</p>
      </Step>
      <Step title="Sign in when it asks">
        <p className="ev-set-hint">It gives you one command to run. Your browser opens; approve Claude Code there. That’s the one part an agent can’t do for you.</p>
      </Step>
    </Steps>
  );
}

/** Do it yourself: the same two commands the app runs. */
function ClaudeCodeByHand({ desktop }: { desktop: boolean }) {
  return (
    <Steps>
      <Step title="Add the Eavesy plugin">
        <p className="ev-set-hint">Paste this into Terminal. It adds the connection plus a skill that tells Claude when to look things up.</p>
        <CopyField label="Claude Code plugin commands" text={CLAUDE_CODE_PLUGIN_CLI} />
      </Step>
      <Step title="Sign in">
        <p className="ev-set-hint">Then run this. Your browser opens; approve Claude Code there.</p>
        <CopyField label="Claude Code sign-in command" text={CLAUDE_CODE_SIGN_IN} />
      </Step>
      <Step title="Check it worked">
        <p className="ev-set-hint">
          {desktop
            ? 'Come back here: Claude Code moves to Connected AI apps by itself.'
            : 'Claude Code shows under Connected AI apps once it’s signed in.'}
        </p>
        <p className="ev-set-hint ev-conn-then">
          Only want the connection, without the skill? Use <code>{CLAUDE_CODE_ADD}</code> for step 1, and <code>claude mcp login eavesy</code> for step 2.
        </p>
      </Step>
    </Steps>
  );
}

/**
 * Claude Code: "Set up" opens three ways to do it. In the Mac app the first is
 * two buttons (add, then sign in), and the row watches Claude Code until it
 * says it's signed in. Then it moves up to Connected AI apps.
 */
function ClaudeCodeApp({ open, toggle, claude, stage, elsewhere, onConnected }: {
  open: boolean;
  toggle: () => void;
  claude: ClaudeCode;
  stage: ClaudeCodeStage;
  /** The account has a Claude Code sign-in, from this Mac or another computer. */
  elsewhere: boolean;
  /** Reloads the account's sign-ins, so Connected AI apps catches up. */
  onConnected: () => void;
}) {
  const { desktop, setStatus, refresh, running } = claude;
  const canRun = stage === 'not-added' || stage === 'needs-sign-in' || stage === 'connected';
  // The one-click way when the app can run it, until you pick another.
  const [chosen, setMethod] = useState<ClaudeMethod | null>(null);
  const method: ClaudeMethod = chosen && (chosen !== 'app' || canRun) ? chosen : canRun ? 'app' : 'agent';
  const [busy, setBusy] = useState<'add' | 'sign-in' | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** When Terminal was opened to sign in; the row checks again every few seconds until then + 5 minutes. */
  const [waiting, setWaiting] = useState<number | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (waiting === null) return;
    const timer = setInterval(() => {
      if (Date.now() - waiting > WAIT_LIMIT_MS) setWaiting(null);
      else { refresh(); onConnected(); }
    }, WAIT_POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh, onConnected]);
  useEffect(() => {
    if (stage !== 'connected') return;
    setWaiting(null);
    onConnected();
  }, [stage, onConnected]);

  const start = (which: 'add' | 'sign-in') => {
    running.current = true;
    setBusy(which);
    setError(null);
  };
  const done = () => {
    running.current = false;
    setBusy(null);
  };
  const add = () => {
    start('add');
    void connectClaudeCode().then(
      (next) => { done(); setStatus(next); },
      (e: unknown) => {
        setError(errMsg(e, 'Couldn’t add Eavesy to Claude Code.'));
        // Part of it may have gone in; show what's there now.
        void claudeCodeStatus().then((next) => setStatus(next)).catch(() => {}).finally(done);
      },
    );
  };
  const signIn = () => {
    start('sign-in');
    void signInClaudeCode()
      .then(() => setWaiting(Date.now()))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t open Terminal.')))
      .finally(done);
  };

  const added = stage === 'needs-sign-in' || stage === 'connected';
  const detail: ReactNode = (() => {
    switch (stage) {
      case 'checking': return 'Checking Claude Code on this Mac…';
      case 'no-cli': return 'Eavesy can’t find Claude Code on this Mac. Set it up with an agent or in Terminal instead.';
      case 'needs-sign-in': return waiting !== null ? 'Waiting for you to approve Claude Code in the browser…' : 'Added. One step left: sign in.';
      case 'connected': return 'Connected. Start a new Claude Code session to use Eavesy.';
      case 'not-added': return elsewhere ? 'Connected on another computer. Not on this Mac yet.' : 'Your meetings, notes and action items as context in Claude Code.';
      default: return 'Your meetings, notes and action items as context in Claude Code.';
    }
  })();
  const methods: { value: ClaudeMethod; label: string }[] = [
    ...(canRun ? [{ value: 'app' as const, label: 'In Eavesy' }] : []),
    { value: 'agent', label: 'With an agent' },
    { value: 'terminal', label: 'In Terminal' },
  ];

  return (
    <AppRow
      mark={<Glyph icon={SquareTerminal} />}
      name="Claude Code"
      detail={detail}
      panelId={panelId}
      action={<SetupToggle open={open} onToggle={toggle} name="Claude Code" controls={panelId} label={stage === 'needs-sign-in' ? 'Finish setup' : 'Set up'} />}
    >
      {open && (
        <>
          <Segmented label="How to set up Claude Code" size="sm" value={method} onChange={setMethod} options={methods} className="ev-conn-methods" />
          {method === 'app' && (
            <Steps>
              <Step title="Add Eavesy to Claude Code" done={added}>
                {added ? (
                  <p className="ev-set-hint">Added: the Eavesy connection, plus a skill that tells Claude when to look things up.</p>
                ) : (
                  <>
                    <p className="ev-set-hint">Installs the Eavesy plugin for every folder. The first time can take a minute.</p>
                    <Button variant="primary" size="sm" className="ev-conn-step-action" loading={busy === 'add'} disabled={busy !== null} onClick={add}>
                      {busy === 'add' ? 'Adding…' : 'Add to Claude Code'}
                    </Button>
                  </>
                )}
              </Step>
              <Step title="Sign in" done={stage === 'connected'}>
                {stage === 'connected' ? (
                  <p className="ev-set-hint">Signed in.</p>
                ) : (
                  <>
                    <p className="ev-set-hint">
                      {waiting !== null
                        ? 'Terminal is open. Approve Claude Code when your browser asks, then come back here.'
                        : 'Terminal opens and your browser asks you to approve Claude Code.'}
                    </p>
                    <div className="ev-conn-step-action">
                      <Button
                        variant={added && waiting === null ? 'primary' : 'outline'}
                        size="sm"
                        icon={Terminal}
                        loading={busy === 'sign-in'}
                        disabled={!added || busy !== null}
                        onClick={signIn}
                      >
                        {waiting !== null ? 'Open Terminal again' : 'Open Terminal to sign in'}
                      </Button>
                      {waiting !== null && <Button variant="ghost" size="sm" onClick={() => setWaiting(null)}>Stop waiting</Button>}
                    </div>
                  </>
                )}
              </Step>
              <Step title={stage === 'connected' ? 'Connected' : 'Done'} done={stage === 'connected'}>
                <p className="ev-set-hint">
                  {stage === 'connected'
                    ? 'Claude Code can use Eavesy now. It’s listed under Connected AI apps.'
                    : 'This turns to Connected by itself once Claude Code is signed in.'}
                </p>
              </Step>
            </Steps>
          )}
          {method === 'agent' && <ClaudeCodeByAgent />}
          {method === 'terminal' && <ClaudeCodeByHand desktop={desktop} />}
          {error && (
            <div className="ev-conn-error" role="alert">
              <p className="ev-set-hint ev-conn-warn">{error}</p>
              <p className="ev-set-hint">Try again, or use “With an agent” or “In Terminal” above.</p>
              <Button variant="outline" size="sm" onClick={added ? signIn : add} disabled={busy !== null}>Try again</Button>
            </div>
          )}
        </>
      )}
    </AppRow>
  );
}

type AppId = 'claude-code' | 'claude' | 'chatgpt' | 'other';

/** Steps for an app you add by pasting the server URL into its settings. */
function UrlSteps({ where, finish }: { where: ReactNode; finish: ReactNode }) {
  return (
    <Steps>
      <Step title="Copy the Eavesy server URL">
        <CopyField label="Eavesy MCP server URL" text={MCP_URL} />
      </Step>
      <Step title={where} />
      <Step title={finish} />
    </Steps>
  );
}

function OtherApps() {
  const [method, setMethod] = useState<'agent' | 'hand'>('agent');
  return (
    <>
      <Segmented
        label="How to set up another MCP app"
        size="sm"
        value={method}
        onChange={setMethod}
        options={[{ value: 'agent', label: 'With its agent' }, { value: 'hand', label: 'By hand' }]}
        className="ev-conn-methods"
      />
      {method === 'agent' ? (
        <Steps>
          <Step title="Copy this prompt">
            <CopyField label="MCP setup prompt" text={MCP_AGENT_PROMPT} block />
          </Step>
          <Step title="Paste it into the app’s agent">
            <p className="ev-set-hint">Cursor, Codex, Windsurf or any agent that can change its own MCP settings.</p>
          </Step>
          <Step title="Approve Eavesy in your browser when it opens" />
        </Steps>
      ) : (
        <UrlSteps
          where="Add a remote MCP server named eavesy with that URL (HTTP, not a local command)"
          finish="When the app signs in, approve it in your browser"
        />
      )}
      {isDesktop() && (
        <p className="ev-set-hint mt-3">
          An app that can’t sign in needs a token instead.{' '}
          <button type="button" className="ev-link" onClick={() => void openWebApp('/settings').catch(() => {})}>Make one on eavesy.com</button>
        </p>
      )}
    </>
  );
}

/** The AI apps Eavesy can be added to, each opening its own numbered steps. */
function AvailableApps({ open, setOpen, claude, stage, showClaudeCode, elsewhere, onConnected }: {
  open: AppId | null;
  setOpen: (next: AppId | null) => void;
  claude: ClaudeCode;
  stage: ClaudeCodeStage;
  showClaudeCode: boolean;
  elsewhere: boolean;
  onConnected: () => void;
}) {
  const ids = { claude: useId(), chatgpt: useId(), other: useId() };
  const toggle = (id: AppId) => setOpen(open === id ? null : id);
  const setUp = (id: Exclude<AppId, 'claude-code'>, name: string) => (
    <SetupToggle open={open === id} onToggle={() => toggle(id)} name={name} controls={ids[id]} />
  );
  return (
    <>
      {showClaudeCode && (
        <ClaudeCodeApp open={open === 'claude-code'} toggle={() => toggle('claude-code')} claude={claude} stage={stage} elsewhere={elsewhere} onConnected={onConnected} />
      )}
      <AppRow mark={<Glyph icon={Asterisk} />} name="Claude" detail="Claude on the web, desktop and phone." action={setUp('claude', 'Claude')} panelId={ids.claude}>
        {open === 'claude' && (
          <UrlSteps
            where={<>In Claude, open <b>Settings → Connectors</b> and choose <b>Add custom connector</b></>}
            finish="Paste the URL and add it. Claude opens Eavesy so you can approve it"
          />
        )}
      </AppRow>
      <AppRow mark={<Glyph icon={MessageCircle} />} name="ChatGPT" detail="Needs developer mode in ChatGPT." action={setUp('chatgpt', 'ChatGPT')} panelId={ids.chatgpt}>
        {open === 'chatgpt' && (
          <UrlSteps
            where={<>In ChatGPT, open <b>Settings → Apps &amp; Connectors</b> and turn on developer mode</>}
            finish="Create a connector, paste the URL, and approve Eavesy when it opens"
          />
        )}
      </AppRow>
      <AppRow mark={<Glyph icon={Plug} />} name="Other MCP apps" detail="Cursor, Codex and anything else that speaks MCP." action={setUp('other', 'another MCP app')} panelId={ids.other}>
        {open === 'other' && <OtherApps />}
      </AppRow>
    </>
  );
}

/**
 * Settings → Connections, laid out like a list of apps: the accounts Eavesy
 * reads (Google Calendar), the AI apps connected over MCP and the ones you can
 * add, then (`children`) what Eavesy does with your agents. Claude Code is in
 * one list or the other, never both. On the Mac (`autoRecord` given), the
 * day's meetings and whether to record each.
 */
export function ConnectionsSettings({ signedIn, active, autoRecord, children }: { signedIn: boolean; active: boolean; autoRecord?: boolean; children?: ReactNode }) {
  const mcp = useMcpTokens(signedIn, active);
  const claude = useClaudeCode(active);
  const [open, setOpen] = useState<AppId | null>(null);
  const stage = claudeCodeStage(claude.desktop, claude.status, mcp.tokens);
  const connected = claudeCodeConnected(stage, mcp.tokens);
  // Signing in just finished with the steps open: keep them up to show it worked, until closed.
  const showClaudeCode = !connected || open === 'claude-code';
  return (
    <>
      <Card title="Accounts">
        <Accounts signedIn={signedIn} active={active} />
      </Card>
      {signedIn && autoRecord !== undefined && (
        <Card title="Record these meetings">
          <UpcomingMeetings autoRecord={autoRecord} active={active} />
        </Card>
      )}
      <Card title="Connected AI apps">
        <ConnectedApps signedIn={signedIn} mcp={mcp} claudeLocal={stage === 'connected'} onClaudeSetup={() => setOpen('claude-code')} />
      </Card>
      <Card title="Add an AI app">
        <AvailableApps open={open} setOpen={setOpen} claude={claude} stage={stage} showClaudeCode={showClaudeCode} elsewhere={!!mcp.tokens?.some(isClaudeCodeToken)} onConnected={mcp.load} />
      </Card>
      {children}
    </>
  );
}
