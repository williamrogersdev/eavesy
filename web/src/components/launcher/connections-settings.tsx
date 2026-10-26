'use client';

import { Check, Copy, PlugZap } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Button, Card } from '@/components/launcher/ui';
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
        <Step
          title="Claude Code"
          hint={<>Run this in your terminal, then run <code>/mcp</code> in Claude Code, pick <b>eavesy</b> and sign in. Your saved prompts become slash commands.</>}
        >
          <CopyLine label="Claude Code command" text={CLAUDE_CODE_ADD} />
        </Step>
        <Step
          title="Claude Code plugin"
          hint="Or install the plugin: the same connection plus a skill that tells Claude when to look up your meetings and dictations. Paste both lines into Claude Code."
        >
          <CopyLine label="Claude Code plugin commands" text={CLAUDE_CODE_PLUGIN} />
        </Step>
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
