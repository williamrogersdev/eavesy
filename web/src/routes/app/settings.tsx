import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { HotkeyRecorder } from '@/components/launcher/hotkey-recorder';
import { getSettings, isDesktop } from '@/lib/desktop/bridge';
import { isRecord, optionalString } from '@/lib/json';
import { AppAlert, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';
import { AccountData } from '@/components/settings/account-data';
import { TemplateManager } from '@/components/settings/template-manager';
import { refreshMe } from '@/lib/api/use-me';

interface Me {
  id: string;
  email?: string;
  displayName?: string;
  companyName?: string | null;
  role?: string | null;
  phoneNumber?: string | null;
  isAnonymous: boolean;
  defaultTranscriptionEngine: 'whisper';
  defaultLanguage: string;
  hasAnthropicKey: boolean;
  anthropicKeyHint?: string | null;
  hasOpenRouterKey: boolean;
  openRouterConnectedAt?: number | null;
}

interface McpToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number | null;
}


export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [saving, setSaving] = useState(false);
  const [anthropic, setAnthropic] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<string | null>(null);
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  const [newMcpUrl, setNewMcpUrl] = useState<string | null>(null);
  const [mcpCopyStatus, setMcpCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [pairCode] = useState(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('pair');
  });
  const [toggleHotkey, setToggleHotkey] = useState('Cmd+Shift+Space');
  const [dictationHotkey, setDictationHotkey] = useState('Cmd+Shift+D');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(() => {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'openrouter') {
      return { kind: 'ok', text: 'OpenRouter connected — AI usage now bills to your account.' };
    }
    if (params.get('error')?.startsWith('openrouter')) {
      return { kind: 'error', text: 'Could not connect OpenRouter. Please try again.' };
    }
    return null;
  });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('connected') || params.has('error')) {
      window.history.replaceState({}, '', '/app/settings');
    }
  }, []);

  useEffect(() => {
    void fetch('/api/me')
      .then(async (r): Promise<unknown> => r.json())
      .then((data) => {
        const account = parseMe(data);
        if (!account) throw new Error('Server returned invalid account settings');
        setMe(account);
        setDisplayName(account.displayName ?? '');
      })
      .catch(() => setError('Could not load account settings.'));
    if (isDesktop()) {
      void getSettings()
        .then((s) => {
          if (s?.toggle_hotkey) setToggleHotkey(s.toggle_hotkey);
          if (s?.dictation_hotkey) setDictationHotkey(s.dictation_hotkey);
        })
        .catch(() => setError('Could not load desktop hotkeys.'));
    }
    void fetch('/api/mcp-tokens')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : []))
      .then((tokens) => setMcpTokens(parseMcpTokens(tokens)))
      .catch(() => setError('Could not load MCP connections.'));
  }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const payload: Record<string, string> = {
        displayName,
        defaultTranscriptionEngine: 'whisper',
      };
      if (anthropic) payload.byoAnthropicKey = anthropic;
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const freshResponse = await fetch('/api/me');
      if (!freshResponse.ok) throw new Error(`Server returned ${freshResponse.status}`);
      const fresh = parseMe(await freshResponse.json());
      if (!fresh) throw new Error('Server returned invalid account settings');
      setMe(fresh);
      void refreshMe();
      setAnthropic('');
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const approvePairing = async () => {
    if (!pairCode) return;
    setPairing(true);
    setPairResult(null);
    try {
      const response = await fetch('/api/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: pairCode }),
      });
      if (!response.ok) throw new Error('This pairing code is invalid or expired.');
      setPairResult('This Mac is connected. You can return to Eavesy.');
    } catch (error) {
      setPairResult(error instanceof Error ? error.message : 'Could not pair this Mac.');
    } finally {
      setPairing(false);
    }
  };

  const createMcpToken = async () => {
    setMcpBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'AI assistant' }),
      });
      if (!response.ok) throw new Error('Could not create MCP connection');
      const created: unknown = await response.json();
      const createdUrl = isRecord(created) ? optionalString(created.url) : undefined;
      if (!createdUrl) throw new Error('Server returned an invalid MCP connection');
      setNewMcpUrl(createdUrl);
      setMcpCopyStatus('idle');
      const refreshResponse = await fetch('/api/mcp-tokens');
      if (!refreshResponse.ok) throw new Error('Could not refresh MCP connections');
      setMcpTokens(parseMcpTokens(await refreshResponse.json()));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create MCP connection.');
    } finally {
      setMcpBusy(false);
    }
  };

  const revokeMcpToken = async (id: string) => {
    setError(null);
    const response = await fetch('/api/mcp-tokens', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) throw new Error('Could not revoke MCP connection');
    setMcpTokens((tokens) => tokens.filter((token) => token.id !== id));
      setNewMcpUrl(null);
      setMcpCopyStatus('idle');
  };

  const copyMcpUrl = async () => {
    if (!newMcpUrl) return;
    try {
      await navigator.clipboard.writeText(newMcpUrl);
      setMcpCopyStatus('copied');
    } catch {
      setError('Could not copy the MCP URL. Select the URL and copy it manually.');
    }
  };

  const disconnectOpenRouter = async () => {
    setError(null);
    const response = await fetch('/api/connections/openrouter', { method: 'DELETE' });
    if (!response.ok) throw new Error('Could not disconnect OpenRouter');
    const freshResponse = await fetch('/api/me');
    if (!freshResponse.ok) throw new Error('Could not refresh account settings');
    const fresh = parseMe(await freshResponse.json());
    if (!fresh) throw new Error('Server returned invalid account settings');
    setMe(fresh);
  };

  if (!me && error) {
    return <AppPage width="compact"><AppAlert>{error}</AppAlert></AppPage>;
  }
  if (!me) {
    return <AppPage width="compact"><p role="status" className="text-sm text-muted-foreground">Loading settings…</p></AppPage>;
  }

  const nameChanged = displayName.trim() !== (me.displayName ?? '');
  const input = 'h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-accent/60';

  return (
    <AppPage width="compact">
      <AppPageHeader title="Settings" />

      {error ? <AppAlert>{error}</AppAlert> : null}
      {notice ? <AppAlert tone={notice.kind === 'ok' ? 'success' : 'danger'}>{notice.text}</AppAlert> : null}
      {saved ? <AppAlert tone="success">Saved.</AppAlert> : null}

      {pairCode ? (
        <AppAlert tone="info">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Approve code <span className="font-mono font-semibold">{pairCode}</span> to connect this Mac.
              {pairResult ? <span className="block text-xs text-muted-foreground">{pairResult}</span> : null}
            </span>
            <button
              type="button"
              onClick={() => void approvePairing()}
              disabled={pairing || pairResult?.startsWith('This Mac')}
              className={appButton('primary', 'sm')}
            >
              {pairing ? 'Connecting…' : 'Approve this Mac'}
            </button>
          </div>
        </AppAlert>
      ) : null}

      <AppSection title="Account">
        <Row label="Email">
          <span className="text-sm">{me.email ?? '—'}</span>
        </Row>
        <Row label="Name" htmlFor="settings-display-name">
          <div className="flex w-full gap-2">
            <input
              id="settings-display-name"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setSaved(false);
              }}
              className={input}
            />
            {nameChanged ? (
              <button type="button" onClick={() => void save()} disabled={saving} className={appButton('primary')}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            ) : null}
          </div>
        </Row>
      </AppSection>

      {isDesktop() ? (
        <AppSection title="Shortcuts" description="Click a shortcut, then press the keys you want.">
          <Row label="Open Eavesy">
            <HotkeyRecorder action="toggle" initial={toggleHotkey} label="Launcher" />
          </Row>
          <Row label="Start dictation">
            <HotkeyRecorder action="dictation" initial={dictationHotkey} label="Dictation" />
          </Row>
        </AppSection>
      ) : null}

      <TemplateManager />

      <AppSection title="AI providers" description="Optional. Without these, Eavesy’s own AI is used.">
        <Row
          label="OpenRouter"
          hint={me.hasOpenRouterKey ? 'Connected — AI usage bills to your OpenRouter credits.' : 'Run on your own account across OpenAI, Anthropic, Google and more.'}
        >
          {me.hasOpenRouterKey ? (
            <button
              type="button"
              onClick={() => void disconnectOpenRouter().catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : 'Could not disconnect OpenRouter.');
              })}
              className={appButton('secondary', 'sm')}
            >
              Disconnect
            </button>
          ) : (
            <a href="/api/connections/openrouter" className={appButton('secondary', 'sm')}>
              Connect
            </a>
          )}
        </Row>
        <Row
          label="Anthropic API key"
          hint={me.anthropicKeyHint ? `Current key ends ${me.anthropicKeyHint}. Summaries and chat bill to it.` : 'Summaries and chat bill to your Anthropic account.'}
          htmlFor="settings-anthropic-key"
        >
          <div className="flex w-full gap-2">
            <input
              id="settings-anthropic-key"
              type="password"
              placeholder="sk-ant-…"
              value={anthropic}
              onChange={(e) => {
                setAnthropic(e.target.value);
                setSaved(false);
              }}
              autoComplete="off"
              className={input}
            />
            {anthropic ? (
              <button type="button" onClick={() => void save()} disabled={saving} className={appButton('primary')}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            ) : null}
          </div>
        </Row>
      </AppSection>

      <AppSection
        title="AI assistants (MCP)"
        description="A read-only URL that lets Claude, Codex or another assistant search your recordings. It’s shown once."
        action={
          <button type="button" onClick={() => void createMcpToken()} disabled={mcpBusy} className={appButton('secondary', 'sm')}>
            {mcpBusy ? 'Creating…' : 'New URL'}
          </button>
        }
      >
        {newMcpUrl ? (
          <AppAlert tone="success">
            <p className="text-xs font-medium">Copy this URL now — it won’t be shown again.</p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                value={newMcpUrl}
                aria-label="New MCP URL"
                className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground"
              />
              <button type="button" onClick={() => void copyMcpUrl()} className={appButton('secondary', 'sm')}>
                {mcpCopyStatus === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p aria-live="polite" className="sr-only">
              {mcpCopyStatus === 'copied' ? 'MCP URL copied to clipboard.' : ''}
            </p>
          </AppAlert>
        ) : null}
        {mcpTokens.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {mcpTokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 truncate">
                  {token.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleDateString()}` : 'not used yet'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void revokeMcpToken(token.id).catch((cause: unknown) => {
                    setError(cause instanceof Error ? cause.message : 'Could not revoke MCP connection.');
                  })}
                  className={appButton('ghost', 'sm')}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </AppSection>

      <AppSection title="Your data">
        <AccountData email={me.email} />
      </AppSection>
    </AppPage>
  );
}

function parseMe(value: unknown): Me | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string' ||
    typeof value.isAnonymous !== 'boolean' ||
    value.defaultTranscriptionEngine !== 'whisper' ||
    typeof value.defaultLanguage !== 'string' ||
    typeof value.hasAnthropicKey !== 'boolean' ||
    typeof value.hasOpenRouterKey !== 'boolean'
  ) {
    return null;
  }
  return {
    id: value.id,
    email: optionalString(value.email),
    displayName: optionalString(value.displayName),
    companyName: nullableString(value.companyName),
    role: nullableString(value.role),
    phoneNumber: nullableString(value.phoneNumber),
    isAnonymous: value.isAnonymous,
    defaultTranscriptionEngine: 'whisper',
    defaultLanguage: value.defaultLanguage,
    hasAnthropicKey: value.hasAnthropicKey,
    anthropicKeyHint: nullableString(value.anthropicKeyHint),
    hasOpenRouterKey: value.hasOpenRouterKey,
    openRouterConnectedAt: nullableNumber(value.openRouterConnectedAt),
  };
}

function parseMcpTokens(value: unknown): McpToken[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): McpToken[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      return [];
    }
    return [{
      id: item.id,
      name: item.name,
      createdAt: item.createdAt,
      lastUsedAt: nullableNumber(item.lastUsedAt),
    }];
  });
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 sm:w-56 sm:shrink-0">
        <Label {...(htmlFor ? { htmlFor } : {})} className="text-sm">
          {label}
        </Label>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 flex-1 justify-start sm:justify-end">{children}</div>
    </div>
  );
}
