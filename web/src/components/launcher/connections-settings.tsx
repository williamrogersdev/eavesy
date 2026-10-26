'use client';

import { Check, Copy, PlugZap, Terminal } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Card } from '@/components/launcher/ui';
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
import { CLAUDE_CODE_ADD, CLAUDE_CODE_PLUGIN_CLI, MCP_URL, type McpToken } from '@/lib/mcp-tokens';

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

function Step({ title, hint, children }: { title: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="ev-conn-step">
      <p className="ev-set-label">{title}</p>
      <p className="ev-set-hint">{hint}</p>
      {children}
    </div>
  );
}

function usedLine(token: McpToken): string {
  const access = token.canWrite ? 'Read & write' : 'Read-only';
  const used = token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleDateString()}` : 'not used yet';
  const expired = token.expiresAt !== null && token.expiresAt <= Date.now();
  return `${access} · ${used}${expired ? ' · expired, sign in again from the app' : ''}`;
}

/** Runs `refresh` again whenever you come back to this window, e.g. from approving in the browser. */
function useOnReturn(active: boolean, refresh: () => void) {
  useEffect(() => {
    if (!active) return;
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [active, refresh]);
}

/** The commands to type yourself, folded away when the app can run them for you. */
function ByHand() {
  return (
    <>
      <CopyLine label="Claude Code plugin commands" text={CLAUDE_CODE_PLUGIN_CLI} />
      <p className="ev-set-hint ev-conn-then">
        Or just the connection, without the skill: <code>{CLAUDE_CODE_ADD}</code>. Then start Claude Code, run <code>/mcp</code>, pick <b>eavesy</b> and sign in.
      </p>
    </>
  );
}

/**
 * Claude Code on this Mac: one button adds Eavesy (the plugin: the connection
 * plus a skill for when to look things up), the next opens Terminal to sign
 * in. On the web, or with no `claude` to run, the commands to type instead.
 */
function ClaudeCodeStep({ active }: { active: boolean }) {
  const [status, setStatus] = useState<ClaudeCodeStatus | null>(null);
  const [busy, setBusy] = useState<'add' | 'sign-in' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  // While a button's command runs, its own answer is the one to show.
  const running = useRef(false);
  const refresh = useCallback(() => {
    if (running.current) return;
    void claudeCodeStatus().then((next) => { if (!running.current) setStatus(next); }).catch(() => {});
  }, []);
  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  useOnReturn(active, refresh);
  const added = !!status && (status.plugin || status.server);
  useEffect(() => { if (!added) setOpened(false); }, [added]);

  if (!isDesktop()) {
    return (
      <Step title="Claude Code" hint="Run this in your terminal. It adds the Eavesy plugin: the connection plus a skill that tells Claude when to look up your meetings and dictations. Then start Claude Code, run /mcp, pick eavesy and sign in.">
        <ByHand />
      </Step>
    );
  }
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
    void connectClaudeCode()
      .then(setStatus)
      .catch((e: unknown) => {
        setError(errMsg(e, 'Couldn’t add Eavesy to Claude Code.'));
        // Half of it may have gone in; show what's there now.
        running.current = false;
        refresh();
      })
      .finally(done);
  };
  const signIn = () => {
    start('sign-in');
    void signInClaudeCode()
      .then(() => setOpened(true))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t open Terminal.')))
      .finally(done);
  };
  const hint = status === null
    ? 'Checking Claude Code on this Mac…'
    : !status.cli
      ? 'Eavesy couldn’t find Claude Code on this Mac. Install it, or run these commands in your terminal.'
      : !added
        ? 'Adds the Eavesy plugin to Claude Code: your meetings, dictations and saved prompts, plus a skill that tells Claude when to look them up.'
        : opened
          ? 'Approve Claude Code in the browser window that opened. It shows up under Connected apps once it’s signed in.'
          : 'Added to Claude Code. Sign in once so it can read your Eavesy account: Terminal opens and your browser asks you to approve it.';
  return (
    <Step title="Claude Code" hint={hint}>
      {status?.cli && (
        <div className="ev-conn-actions">
          {added ? (
            <>
              <span className="ev-conn-done"><Check className="h-4 w-4" aria-hidden /> Added</span>
              <Button variant="primary" size="sm" icon={Terminal} loading={busy === 'sign-in'} disabled={busy !== null} onClick={signIn}>
                {opened ? 'Open sign-in again' : 'Sign in'}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" loading={busy === 'add'} disabled={busy !== null} onClick={add}>
              {busy === 'add' ? 'Adding…' : 'Add to Claude Code'}
            </Button>
          )}
        </div>
      )}
      {error && <p role="alert" className="ev-set-hint">{error}</p>}
      {status && (status.cli ? (
        <>
          <button type="button" className="ev-link ev-conn-more" aria-expanded={showCommands} onClick={() => setShowCommands(!showCommands)}>
            {showCommands ? 'Hide the commands' : 'Or run it yourself'}
          </button>
          {showCommands && <ByHand />}
        </>
      ) : <ByHand />)}
    </Step>
  );
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
  useOnReturn(signedIn && active, load);
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
        <p className="ev-set-hint">Nothing connected yet. An app shows up here once it signs in to Eavesy.</p>
      )}
      {tokens?.map((token) => (
        <div key={token.id} className="ev-set-row ev-conn-app">
          <PlugZap className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="ev-set-label truncate">{token.name}</p>
            <p className="ev-set-hint">{usedLine(token)}</p>
          </div>
          <Button variant="ghost" size="sm" loading={revoking === token.id} disabled={revoking !== null} onClick={() => revoke(token.id)}>
            Disconnect
          </Button>
        </div>
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

/**
 * Settings → Connections: how to add Eavesy to Claude Code, Claude and ChatGPT
 * over MCP, which apps are connected, and (`children`) the switches for what
 * Eavesy does with your agents.
 */
export function ConnectionsSettings({ signedIn, active, children }: { signedIn: boolean; active: boolean; children?: ReactNode }) {
  return (
    <>
      <Card title="Connect an AI tool">
        <ClaudeCodeStep active={active} />
        <Step
          title="Claude, ChatGPT and other apps"
          hint={<>Add a custom connector with this URL (Claude: Settings → Connectors. ChatGPT: Settings → Apps &amp; Connectors, in developer mode). The app opens Eavesy so you can approve it.</>}
        >
          <CopyLine label="Eavesy MCP server URL" text={MCP_URL} />
        </Step>
        {isDesktop() && (
          <p className="ev-set-hint ev-conn-foot">
            An app that can’t sign in needs a token instead.{' '}
            <button type="button" className="ev-link" onClick={() => void openWebApp('/settings').catch(() => {})}>Make one on eavesy.com</button>
          </p>
        )}
      </Card>
      <Card title="Connected apps">
        <ConnectedApps signedIn={signedIn} active={active} />
      </Card>
      {children}
    </>
  );
}
