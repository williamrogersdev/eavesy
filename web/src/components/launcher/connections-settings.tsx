'use client';

import { Asterisk, Check, ChevronDown, Copy, MessageCircle, Plug, SquareTerminal, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card, Menu } from '@/components/launcher/ui';
import { connectGoogle, disconnectCalendar, getCalendarStatus, NOT_REVOKED, type CalendarStatus } from '@/lib/api/calendar';
import { listMcpTokens, revokeMcpToken } from '@/lib/api/mcp-tokens';
import { copyText, errMsg, isDesktop, openWebApp } from '@/lib/desktop/bridge';
import { CLAUDE_CODE_ADD, CLAUDE_CODE_PLUGIN, MCP_URL, type McpToken } from '@/lib/mcp-tokens';

/** A command or URL to copy, with a Copy button that says when it worked. */
function CopyLine({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="ev-conn-copy">
      <code aria-label={label}>{text}</code>
      <Button
        variant="outline"
        size="sm"
        icon={copied ? Check : Copy}
        onClick={() => void copyText(text).then(() => setCopied(true)).catch(() => {})}
      >
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
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
function AppRow({ mark, name, detail, action, children }: { mark: ReactNode; name: string; detail?: ReactNode; action?: ReactNode; children?: ReactNode }) {
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
      {children && <div className="ev-conn-more">{children}</div>}
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

/** Picks a mark for an MCP app from the name it signed in with. */
function markFor(name: string): LucideIcon {
  const n = name.toLowerCase();
  if (n.includes('claude code')) return SquareTerminal;
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

/** The AI apps signed in to this account over MCP, each one revocable. */
function ConnectedApps({ signedIn, active }: { signedIn: boolean; active: boolean }) {
  const [tokens, setTokens] = useState<McpToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void listMcpTokens()
      .then(setTokens)
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your connected apps.')));
  }, []);
  // Reloaded each time the page is shown, so an app approved a moment ago appears.
  useEffect(() => { if (signedIn && active) load(); }, [signedIn, active, load]);
  if (!signedIn) {
    return <p className="ev-set-hint">Sign in to see the apps connected to your Eavesy account.</p>;
  }
  const revoke = (id: string) => {
    setRevoking(id);
    setError(null);
    void revokeMcpToken(id)
      .then(() => setTokens((list) => list?.filter((token) => token.id !== id) ?? list))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t disconnect that app.')))
      .finally(() => setRevoking(null));
  };
  return (
    <>
      {tokens === null && !error && <p className="ev-set-hint">Checking…</p>}
      {tokens?.length === 0 && (
        <p className="ev-set-hint">None yet. Add one below and it shows up here once it signs in.</p>
      )}
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
              items={[{ label: 'Disconnect', tone: 'warn', onSelect: () => revoke(token.id) }]}
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

type AppId = 'claude-code' | 'claude' | 'chatgpt' | 'other';

/** The AI apps Eavesy can be added to, each opening its own short steps. */
function AvailableApps() {
  const [open, setOpen] = useState<AppId | null>(null);
  const toggle = (id: AppId) => setOpen((current) => (current === id ? null : id));
  const setUp = (id: AppId, name: string) => (
    <Button variant="outline" size="sm" aria-expanded={open === id} aria-label={`Connect ${name}`} onClick={() => toggle(id)}>
      {open === id ? 'Done' : 'Connect'}
    </Button>
  );
  return (
    <>
      <AppRow mark={<Glyph icon={SquareTerminal} />} name="Claude Code" detail="Your meetings and notes as context, your prompts as slash commands." action={setUp('claude-code', 'Claude Code')}>
        {open === 'claude-code' && (
          <>
            <p className="ev-set-hint">Run this in your terminal, then <code>/mcp</code> in Claude Code, pick <b>eavesy</b> and sign in.</p>
            <CopyLine label="Claude Code command" text={CLAUDE_CODE_ADD} />
            <p className="ev-set-hint mt-3">Or install the plugin, which also teaches Claude when to look things up. Paste both lines into Claude Code.</p>
            <CopyLine label="Claude Code plugin commands" text={CLAUDE_CODE_PLUGIN} />
          </>
        )}
      </AppRow>
      <AppRow mark={<Glyph icon={Asterisk} />} name="Claude" detail="Claude on the web, desktop and phone." action={setUp('claude', 'Claude')}>
        {open === 'claude' && (
          <>
            <p className="ev-set-hint">In Claude, open Settings → Connectors → Add custom connector and paste this URL. Claude opens Eavesy so you can approve it.</p>
            <CopyLine label="Eavesy MCP server URL" text={MCP_URL} />
          </>
        )}
      </AppRow>
      <AppRow mark={<Glyph icon={MessageCircle} />} name="ChatGPT" detail="Needs developer mode in ChatGPT." action={setUp('chatgpt', 'ChatGPT')}>
        {open === 'chatgpt' && (
          <>
            <p className="ev-set-hint">In ChatGPT, open Settings → Apps &amp; Connectors, turn on developer mode, create a connector and paste this URL.</p>
            <CopyLine label="Eavesy MCP server URL" text={MCP_URL} />
          </>
        )}
      </AppRow>
      <AppRow mark={<Glyph icon={Plug} />} name="Other MCP apps" detail="Cursor, Codex and anything else that speaks MCP." action={setUp('other', 'another MCP app')}>
        {open === 'other' && (
          <>
            <p className="ev-set-hint">Add a remote MCP server with this URL. Apps that sign in open Eavesy so you can approve them.</p>
            <CopyLine label="Eavesy MCP server URL" text={MCP_URL} />
            {isDesktop() && (
              <p className="ev-set-hint mt-3">
                An app that can’t sign in needs a token instead.{' '}
                <button type="button" className="ev-link" onClick={() => void openWebApp('/settings').catch(() => {})}>Make one on eavesy.com</button>
              </p>
            )}
          </>
        )}
      </AppRow>
    </>
  );
}

/**
 * Settings → Connections, laid out like a list of apps: the accounts Eavesy
 * reads (Google Calendar), the AI apps connected over MCP and the ones you can
 * add, then (`children`) what Eavesy does with your agents.
 */
export function ConnectionsSettings({ signedIn, active, children }: { signedIn: boolean; active: boolean; children?: ReactNode }) {
  return (
    <>
      <Card title="Accounts">
        <Accounts signedIn={signedIn} active={active} />
      </Card>
      <Card title="Connected AI apps">
        <ConnectedApps signedIn={signedIn} active={active} />
      </Card>
      <Card title="Add an AI app">
        <AvailableApps />
      </Card>
      {children}
    </>
  );
}
