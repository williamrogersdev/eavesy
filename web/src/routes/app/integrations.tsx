import { createFileRoute } from '@tanstack/react-router';
import { Apple, Bot, Check, Copy, Sparkles, Terminal, Webhook } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { ApiKeysCard } from '@/components/integrations/api-keys';
import { GoogleCalendarCards, googleOutcome } from '@/components/integrations/google-calendar';
import { IntegrationCard, IntegrationGroup } from '@/components/integrations/integration-card';
import { WebhookSettings } from '@/components/settings/webhook-settings';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppPage, AppPageHeader, appButton, appInput } from '@/components/ui/app-page';
import { isDesktop } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';
import { CLAUDE_CODE_ADD, MCP_URL } from '@/lib/mcp-tokens';

export const Route = createFileRoute('/app/integrations')({ component: IntegrationsPage });

interface Providers {
  hasMac: boolean;
  hasOpenRouterKey: boolean;
  hasAnthropicKey: boolean;
  anthropicKeyHint: string | null;
}

function parseProviders(value: unknown): Providers | null {
  if (!isRecord(value)) return null;
  return {
    hasMac: value.hasMac === true,
    hasOpenRouterKey: value.hasOpenRouterKey === true,
    hasAnthropicKey: value.hasAnthropicKey === true,
    anthropicKeyHint: typeof value.anthropicKeyHint === 'string' ? value.anthropicKeyHint : null,
  };
}

function IntegrationsPage() {
  const [me, setMe] = useState<Providers | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read from the URL after hydration, so the server and first client render agree.
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [anthropic, setAnthropic] = useState('');
  const [addingKey, setAddingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const copyFailed = useCallback(() => setError('Could not copy it. Select the text and copy it yourself.'), []);

  const loadMe = useCallback(async () => {
    const response = await fetch('/api/me');
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const parsed = parseProviders(await response.json());
    if (!parsed) throw new Error('Server returned invalid account settings');
    setMe(parsed);
  }, []);

  useEffect(() => {
    void loadMe().catch(() => setError('Could not load your integrations.'));
  }, [loadMe]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') === 'openrouter') setNotice({ kind: 'ok', text: 'OpenRouter connected.' });
    else if (params.get('error')?.startsWith('openrouter')) setNotice({ kind: 'error', text: 'Could not connect OpenRouter. Try again.' });
    else if (params.get('error') === 'signin_required') setNotice({ kind: 'error', text: 'Sign in, then connect again.' });
    else if (params.has('error')) setNotice({ kind: 'error', text: 'Could not finish connecting. Try again.' });
    const google = googleOutcome(params);
    if (google) setNotice(google);
    if (params.has('connected') || params.has('error')) window.history.replaceState({}, '', '/app/integrations');
  }, []);

  const saveAnthropic = async (value: string | null = anthropic) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ byoAnthropicKey: value }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      await loadMe();
      setAnthropic('');
      setAddingKey(false);
    } catch (cause) {
      setError(cause instanceof Error ? `Could not save the key: ${cause.message}` : 'Could not save the key.');
    } finally {
      setSaving(false);
    }
  };

  const disconnectOpenRouter = async () => {
    setError(null);
    setDisconnecting(true);
    try {
      const response = await fetch('/api/connections/openrouter', { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not disconnect OpenRouter.');
      await loadMe();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect OpenRouter.');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <AppPage width="reading">
      <AppPageHeader title="Integrations" description="Everything Eavesy connects to, in one place." />

      {error ? <AppAlert>{error}</AppAlert> : null}
      {notice ? <AppAlert tone={notice.kind === 'ok' ? 'success' : 'danger'}>{notice.text}</AppAlert> : null}

      <IntegrationGroup title="Calendar">
        <GoogleCalendarCards onError={setError} />
      </IntegrationGroup>

      <IntegrationGroup title="AI assistants">
        <IntegrationCard
          icon={<Bot />}
          name="Claude and ChatGPT"
          blurb={`Add ${MCP_URL} as a connector and sign in`}
          action={<CopyButton text={MCP_URL} label="Copy URL" onFail={copyFailed} />}
        />
        <IntegrationCard
          icon={<Terminal />}
          name="Claude Code"
          blurb="Run one command in your terminal, then sign in"
          action={<CopyButton text={CLAUDE_CODE_ADD} label="Copy command" onFail={copyFailed} />}
        />
      </IntegrationGroup>

      <IntegrationGroup title="Devices">
        <IntegrationCard
          icon={<Apple />}
          name="Mac app"
          blurb="Record meetings and dictate anywhere on your Mac"
          status={me?.hasMac || isDesktop() ? { text: 'Connected', tone: 'on' } : undefined}
          action={me && !me.hasMac && !isDesktop() ? <Link href="/download/mac" className={appButton('primary', 'sm')}>Download</Link> : null}
        />
      </IntegrationGroup>

      <IntegrationGroup title="Your own AI account">
        <IntegrationCard
          icon={<Sparkles />}
          name="OpenRouter"
          blurb="Bill chat, translation and screenshot descriptions to your credits"
          status={me?.hasOpenRouterKey ? { text: 'Connected', tone: 'on' } : undefined}
          action={me?.hasOpenRouterKey ? (
            <button type="button" disabled={disconnecting} onClick={() => void disconnectOpenRouter()} className={appButton('ghost', 'sm')}>
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          ) : (
            <a href="/api/connections/openrouter" className={appButton('secondary', 'sm')}>Connect</a>
          )}
        />
        <IntegrationCard
          icon={<Sparkles />}
          name="Anthropic"
          blurb={me?.anthropicKeyHint ? `Summaries and chat bill to the key ending ${me.anthropicKeyHint}` : 'Bill summaries and chat to your own API key'}
          status={me?.hasAnthropicKey ? { text: 'Connected', tone: 'on' } : undefined}
          action={addingKey ? null : (
            <>
              {me?.hasAnthropicKey ? (
                <button type="button" disabled={saving} onClick={() => void saveAnthropic(null)} className={appButton('ghost', 'sm')}>Remove</button>
              ) : null}
              <button type="button" onClick={() => setAddingKey(true)} className={appButton('secondary', 'sm')}>
                {me?.hasAnthropicKey ? 'Replace key' : 'Add key'}
              </button>
            </>
          )}
        >
          {addingKey ? (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (anthropic && !saving) void saveAnthropic();
              }}
            >
              <input
                type="password"
                aria-label="Anthropic API key"
                placeholder="sk-ant-…"
                value={anthropic}
                onChange={(event) => setAnthropic(event.target.value)}
                autoComplete="off"
                autoFocus
                className={appInput}
              />
              <button type="submit" disabled={!anthropic || saving} className={appButton('primary')}>{saving ? 'Saving…' : 'Save'}</button>
              <button type="button" onClick={() => { setAddingKey(false); setAnthropic(''); }} className={appButton('ghost')}>Cancel</button>
            </form>
          ) : null}
        </IntegrationCard>
      </IntegrationGroup>

      <IntegrationGroup title="Developers">
        <ApiKeysCard onError={setError} />
        <IntegrationCard
          icon={<Webhook />}
          name="Webhooks"
          blurb="Get a signed POST when a recording, dictation or note is saved"
          action={
            <button type="button" aria-expanded={webhooksOpen} onClick={() => setWebhooksOpen((open) => !open)} className={appButton('secondary', 'sm')}>
              {webhooksOpen ? 'Hide' : 'Manage'}
            </button>
          }
        >
          {webhooksOpen ? <WebhookSettings /> : null}
        </IntegrationCard>
      </IntegrationGroup>
    </AppPage>
  );
}

function CopyButton({ text, label, onFail }: { text: string; label: string; onFail: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }, onFail);
      }}
      className={appButton('secondary', 'sm')}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </button>
  );
}
