import { DictionarySettings } from '@/components/dictionary/dictionary-settings';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { isRecord, optionalString } from '@/lib/json';
import { AppAlert, AppPage, AppPageHeader, AppSection, appButton } from '@/components/ui/app-page';
import { AccountData } from '@/components/settings/account-data';
import { TemplateManager } from '@/components/settings/template-manager';
import { refreshMe } from '@/lib/api/use-me';
import { NOTES_LANGUAGES } from '@/lib/transcription/language';
import { DICTATION_STYLES, dictationStyle, FOR_AGENTS_HINT, type DictationStyle } from '@/lib/transcription/dictation-style';
import { SpokenLanguages } from '@/components/settings/spoken-languages';
import { MAX_TERM_LENGTH, MAX_VOCABULARY_TERMS } from '@/lib/transcription/vocabulary';
import { ChipInput } from '@/components/ui/chip-input';
import { SaveToast, useSaveToast } from '@/components/ui/save-toast';
import { Link } from '@/components/ui/app-link';

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
  spokenLanguages: string[];
  customVocabulary: string[];
  dictationStyle: DictationStyle;
  dictationForAgents: boolean;
  emailRecaps: boolean;
  emailRecapTranscript: boolean;
  emailRecapsAvailable: boolean;
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
  const vocabularySave = useRef(0);
  const savedVocabulary = useRef<{ attempt: number; words: string[] }>({ attempt: 0, words: [] });
  const navigate = useNavigate();
  const toast = useSaveToast();
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
    if (window.location.hash === '#projects') void navigate({ to: '/app/projects', replace: true });
  }, [navigate]);

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
        savedVocabulary.current = { attempt: 0, words: account.customVocabulary };
      })
      .catch(() => setError('Could not load account settings.'));
    void fetch('/api/mcp-tokens')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : []))
      .then((tokens) => setMcpTokens(parseMcpTokens(tokens)))
      .catch(() => setError('Could not load MCP connections.'));
  }, []);

  const save = async () => {
    setSaving(true);
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
      if (!anthropic) {
        setMe((current) => (current ? { ...current, displayName: displayName.trim() } : current));
        void refreshMe();
        toast.show();
        return;
      }
      const freshResponse = await fetch('/api/me');
      if (!freshResponse.ok) throw new Error(`Server returned ${freshResponse.status}`);
      const fresh = parseMe(await freshResponse.json());
      if (!fresh) throw new Error('Server returned invalid account settings');
      setMe(fresh);
      void refreshMe();
      setAnthropic('');
      toast.show();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const saveLanguage = async (change: Partial<Pick<Me, 'defaultLanguage' | 'notesLanguage' | 'spokenLanguages' | 'dictationStyle' | 'dictationForAgents'>>) => {
    const previous = me;
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
      toast.show();
    } catch (cause) {
      setMe(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save the language.');
    }
  };

  const saveRecaps = async (change: Partial<Pick<Me, 'emailRecaps' | 'emailRecapTranscript'>>) => {
    const previous = me;
    setError(null);
    if (previous) setMe({ ...previous, ...change });
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(change),
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(isRecord(body) && typeof body.error === 'string' && body.error !== 'invalid_request' ? body.error : `Server returned ${response.status}`);
      }
      toast.show();
    } catch (cause) {
      setMe(previous);
      setError(cause instanceof Error ? cause.message : 'Could not save email recaps.');
    }
  };

  const saveVocabulary = async (customVocabulary: string[]) => {
    const attempt = ++vocabularySave.current;
    setError(null);
    setMe((current) => (current ? { ...current, customVocabulary } : current));
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ customVocabulary }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      if (attempt > savedVocabulary.current.attempt) savedVocabulary.current = { attempt, words: customVocabulary };
      if (attempt === vocabularySave.current) toast.show();
    } catch (cause) {
      if (attempt !== vocabularySave.current) return;
      setMe((current) => (current ? { ...current, customVocabulary: savedVocabulary.current.words } : current));
      setError(cause instanceof Error ? `Could not save your words: ${cause.message}` : 'Could not save your words.');
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
    return <AppPage width="compact"><p role="status" className="text-sm text-ev-ink-2">Loading settings…</p></AppPage>;
  }

  const nameChanged = displayName.trim() !== (me.displayName ?? '');
  const input = 'h-9 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat';

  return (
    <AppPage width="compact">
      <AppPageHeader title="Settings" />

      {error ? <AppAlert>{error}</AppAlert> : null}
      {notice ? <AppAlert tone={notice.kind === 'ok' ? 'success' : 'danger'}>{notice.text}</AppAlert> : null}

      {pairCode ? (
        <AppAlert tone="info">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Approve code <span className="font-round font-semibold">{pairCode}</span> to connect this Mac.
              {pairResult ? <span className="block text-xs text-ev-ink-2">{pairResult}</span> : null}
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
              onChange={(e) => setDisplayName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameChanged && !saving) void save();
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
          label="Languages you speak"
          hint="Eavesy picks up whichever of these is spoken, line by line, even when a call switches between them. Leave it empty to detect any language."
          htmlFor="settings-language"
        >
          <SpokenLanguages
            id="settings-language"
            value={me.spokenLanguages}
            onChange={(spokenLanguages) => void saveLanguage({ spokenLanguages, defaultLanguage: 'auto' })}
          />
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
          label="Dictation tone"
          hint={DICTATION_STYLES.find((style) => style.id === me.dictationStyle)?.hint ?? ''}
          htmlFor="settings-dictation-style"
        >
          <select
            id="settings-dictation-style"
            value={me.dictationStyle}
            onChange={(e) => void saveLanguage({ dictationStyle: dictationStyle(e.target.value) })}
            className={`${input} sm:w-56`}
          >
            {DICTATION_STYLES.map((style) => (
              <option key={style.id} value={style.id}>
                {style.label}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Format dictation for AI agents" hint={FOR_AGENTS_HINT} htmlFor="settings-dictation-agents">
          <input
            id="settings-dictation-agents"
            type="checkbox"
            checked={me.dictationForAgents}
            onChange={(e) => void saveLanguage({ dictationForAgents: e.target.checked })}
          />
        </Row>
        <div className="flex flex-col gap-1.5">
          <div>
            <label htmlFor="settings-vocabulary" className="text-sm">Custom words</label>
            <p className="text-xs text-ev-ink-2">
              Names, products and jargon to spell your way in every recording. Words for one client or codebase belong
              in <Link href="/app/projects" className="underline underline-offset-2 hover:text-ev-ink">Projects</Link>.
            </p>
          </div>
          <ChipInput
            id="settings-vocabulary"
            label="Custom words"
            value={me.customVocabulary}
            onChange={(next) => void saveVocabulary(next)}
            max={MAX_VOCABULARY_TERMS}
            maxLength={MAX_TERM_LENGTH}
            placeholder="Eavesy, Priya Raman, Kubernetes…"
            hint="Press Enter or comma after each, or paste a list. Saves as you go."
          />
        </div>
      </AppSection>

      <TemplateManager />

      <AppSection
        title="Email recaps"
        description={me.emailRecapsAvailable
          ? `When a meeting finishes, Eavesy emails ${me.email ?? 'you'} its TL;DR, decisions, action items and a link to the transcript. Only you get it.`
          : 'Email recaps are not set up on this server.'}
      >
        <Row label="Email me a recap" hint="One email per finished meeting, to your account's address." htmlFor="settings-email-recaps">
          <input
            id="settings-email-recaps"
            type="checkbox"
            checked={me.emailRecaps}
            disabled={!me.emailRecapsAvailable || me.isAnonymous || !me.email}
            onChange={(e) => void saveRecaps({ emailRecaps: e.target.checked })}
          />
        </Row>
        <Row label="Attach the transcript" hint="Adds the full transcript as a text file." htmlFor="settings-email-recap-transcript">
          <input
            id="settings-email-recap-transcript"
            type="checkbox"
            checked={me.emailRecapTranscript}
            disabled={!me.emailRecapsAvailable || !me.emailRecaps}
            onChange={(e) => void saveRecaps({ emailRecapTranscript: e.target.checked })}
          />
        </Row>
      </AppSection>

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
              onChange={(e) => setAnthropic(e.target.value)}
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
            <label className="flex items-center gap-1.5 text-xs text-ev-ink-2">
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
                className="min-w-0 flex-1 resize-none rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2 py-1 font-mono text-xs text-ev-ink"
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
          <ul className="divide-y divide-ev-line rounded-[var(--ev-r-ctl)] border border-ev-line">
            {mcpTokens.map((token) => (
              <li key={token.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block truncate">
                    {token.name}
                    <span className="ml-2 text-xs text-ev-ink-2">
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
                    <span className="block text-xs text-ev-warn-ink">
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

      <AppSection title="Personal dictionary">
        <DictionarySettings />
      </AppSection>
      <AppSection title="Your data">
        <AccountData email={me.email} />
      </AppSection>

      <SaveToast text={toast.text} />
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
    spokenLanguages: Array.isArray(value.spokenLanguages)
      ? value.spokenLanguages.filter((code): code is string => typeof code === 'string')
      : [],
    customVocabulary: Array.isArray(value.customVocabulary)
      ? value.customVocabulary.filter((term): term is string => typeof term === 'string')
      : [],
    dictationStyle: dictationStyle(value.dictationStyle),
    dictationForAgents: value.dictationForAgents === true,
    emailRecaps: value.emailRecaps === true,
    emailRecapTranscript: value.emailRecapTranscript === true,
    emailRecapsAvailable: value.emailRecapsAvailable === true,
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
        {hint ? <p className="text-xs text-ev-ink-2">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 flex-1 justify-start sm:justify-end">{children}</div>
    </div>
  );
}
