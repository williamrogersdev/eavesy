import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { isRecord, optionalString } from '@/lib/json';
import { AppAlert, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';
import { AccountData } from '@/components/settings/account-data';
import { TemplateManager } from '@/components/settings/template-manager';
import { refreshMe } from '@/lib/api/use-me';
import { NOTES_LANGUAGES, TRANSCRIPTION_LANGUAGES } from '@/lib/transcription/language';
import { MAX_VOCABULARY_TERMS, vocabularyFromText } from '@/lib/transcription/vocabulary';

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
  notesLanguage: string | null;
  customVocabulary: string[];
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
  expiresAt: number | null;
  canWrite: boolean;
  usesLegacyUrl: boolean;
}

/** A client config with the token in the Authorization header, not the URL. */
function mcpClientConfig(serverUrl: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { eavesy: { type: 'http', url: serverUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}


export const Route = createFileRoute('/app/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [saving, setSaving] = useState(false);
  const [anthropic, setAnthropic] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [vocabulary, setVocabulary] = useState('');
  const [savingVocabulary, setSavingVocabulary] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairResult, setPairResult] = useState<string | null>(null);
  const [mcpTokens, setMcpTokens] = useState<McpToken[]>([]);
  const [newMcpConfig, setNewMcpConfig] = useState<string | null>(null);
  const [mcpCopyStatus, setMcpCopyStatus] = useState<'idle' | 'copied'>('idle');
  const [mcpBusy, setMcpBusy] = useState(false);
  const [mcpAllowWrite, setMcpAllowWrite] = useState(false);
  const [pairCode] = useState(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('pair');
  });
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
        setVocabulary(account.customVocabulary.join('\n'));
      })
      .catch(() => setError('Could not load account settings.'));
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

  const saveLanguage = async (change: Partial<Pick<Me, 'defaultLanguage' | 'notesLanguage'>>) => {
    const previous = me;
    setSaved(false);
    setError(null);
    if (previous) setMe({ ...previous, ...change });
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      void refreshMe();
      setSaved(true);
    } catch (cause) {
      setMe(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save the language.');
    }
  };

  const saveVocabulary = async () => {
    const customVocabulary = vocabularyFromText(vocabulary);
    setSavingVocabulary(true);
    setSaved(false);
    setError(null);
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customVocabulary }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setMe((current) => (current ? { ...current, customVocabulary } : current));
      setVocabulary(customVocabulary.join('\n'));
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your words.');
    } finally {
      setSavingVocabulary(false);
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
        body: JSON.stringify({ name: 'AI assistant', scopes: mcpAllowWrite ? ['read', 'write'] : ['read'] }),
      });
      if (!response.ok) throw new Error('Could not create MCP connection');
      const created: unknown = await response.json();
      const serverUrl = isRecord(created) ? optionalString(created.serverUrl) : undefined;
      const token = isRecord(created) ? optionalString(created.token) : undefined;
      if (!serverUrl || !token) throw new Error('Server returned an invalid MCP connection');
      setNewMcpConfig(mcpClientConfig(serverUrl, token));
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
    setNewMcpConfig(null);
    setMcpCopyStatus('idle');
  };

  const copyMcpConfig = async () => {
    if (!newMcpConfig) return;
    try {
      await navigator.clipboard.writeText(newMcpConfig);
      setMcpCopyStatus('copied');
    } catch {
      setError('Could not copy the MCP configuration. Select it and copy it manually.');
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
  const vocabularyChanged = vocabularyFromText(vocabulary).join('\n') !== me.customVocabulary.join('\n');
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

      <AppSection title="Transcription">
        <Row
          label="Spoken language"
          hint="Detect automatically follows whatever language people speak, line by line, even when a call switches between languages. Pick one only if every meeting is in it."
          htmlFor="settings-language"
        >
          <select
            id="settings-language"
            value={me.defaultLanguage}
            onChange={(e) => void saveLanguage({ defaultLanguage: e.target.value })}
            className={`${input} sm:w-56`}
          >
            {TRANSCRIPTION_LANGUAGES.some((language) => language.code === me.defaultLanguage) ? null : (
              <option value={me.defaultLanguage}>{me.defaultLanguage}</option>
            )}
            {TRANSCRIPTION_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Notes language"
          hint="Notes are written in this language, and transcripts in any other language get a Translate button. Same as the meeting keeps each meeting in the language it was spoken in."
          htmlFor="settings-notes-language"
        >
          <select
            id="settings-notes-language"
            value={me.notesLanguage ?? ''}
            onChange={(e) => void saveLanguage({ notesLanguage: e.target.value || null })}
            className={`${input} sm:w-56`}
          >
            <option value="">Same as the meeting</option>
            {NOTES_LANGUAGES.map((language) => (
              <option key={language.code} value={language.code}>
                {language.label}
              </option>
            ))}
          </select>
        </Row>
        <Row
          label="Custom words"
          hint={`Names, products and jargon to spell your way, one per line or separated by commas (so a phrase can’t contain one). Up to ${MAX_VOCABULARY_TERMS}.`}
          htmlFor="settings-vocabulary"
        >
          <div className="flex w-full flex-col items-end gap-2">
            <textarea
              id="settings-vocabulary"
              rows={4}
              placeholder={'Eavesy\nPriya Raman\nKubernetes'}
              value={vocabulary}
              onChange={(e) => {
                setVocabulary(e.target.value);
                setSaved(false);
              }}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            {vocabularyChanged ? (
              <button
                type="button"
                onClick={() => void saveVocabulary()}
                disabled={savingVocabulary}
                className={appButton('primary', 'sm')}
              >
                {savingVocabulary ? 'Saving…' : 'Save words'}
              </button>
            ) : null}
          </div>
        </Row>
      </AppSection>

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
        description="A connection that lets Claude, Codex or another assistant search your recordings. Connections are read-only unless you allow writes, and last 90 days."
        action={
          <span className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={mcpAllowWrite}
                onChange={(event) => setMcpAllowWrite(event.target.checked)}
              />
              Allow writes
            </label>
            <button type="button" onClick={() => void createMcpToken()} disabled={mcpBusy} className={appButton('secondary', 'sm')}>
              {mcpBusy ? 'Creating…' : 'New connection'}
            </button>
          </span>
        }
      >
        {newMcpConfig ? (
          <AppAlert tone="success">
            <p className="text-xs font-medium">
              Add this to your assistant’s MCP settings now. The token won’t be shown again.
            </p>
            <div className="mt-2 flex items-start gap-2">
              <textarea
                readOnly
                value={newMcpConfig}
                rows={newMcpConfig.split('\n').length}
                wrap="off"
                aria-label="New MCP configuration"
                className="min-w-0 flex-1 resize-none rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground"
              />
              <button type="button" onClick={() => void copyMcpConfig()} className={appButton('secondary', 'sm')}>
                {mcpCopyStatus === 'copied' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p aria-live="polite" className="sr-only">
              {mcpCopyStatus === 'copied' ? 'MCP configuration copied to clipboard.' : ''}
            </p>
          </AppAlert>
        ) : null}
        {mcpTokens.length ? (
          <ul className="divide-y divide-border rounded-md border border-border">
            {mcpTokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">
                    {token.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {token.canWrite ? 'read & write · ' : 'read-only · '}
                      {token.lastUsedAt ? `used ${new Date(token.lastUsedAt).toLocaleDateString()}` : 'not used yet'}
                      {token.expiresAt
                        ? token.expiresAt <= Date.now()
                          ? ' · expired'
                          : ` · expires ${new Date(token.expiresAt).toLocaleDateString()} if unused`
                        : null}
                    </span>
                  </span>
                  {token.usesLegacyUrl ? (
                    <span className="block text-xs text-danger">
                      Uses the old URL-based setup, which is being retired. Create a new connection and replace it.
                    </span>
                  ) : null}
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
    notesLanguage: typeof value.notesLanguage === 'string' ? value.notesLanguage : null,
    customVocabulary: Array.isArray(value.customVocabulary)
      ? value.customVocabulary.filter((term): term is string => typeof term === 'string')
      : [],
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
      expiresAt: nullableNumber(item.expiresAt),
      canWrite: Array.isArray(item.scopes) && item.scopes.includes('write'),
      usesLegacyUrl: item.usesLegacyUrl === true,
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
