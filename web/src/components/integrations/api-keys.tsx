'use client';

import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AppAlert, appButton } from '@/components/ui/app-page';
import { isRecord, optionalString } from '@/lib/json';
import { MCP_URL, parseMcpTokens, type McpToken } from '@/lib/mcp-tokens';
import { IntegrationCard } from './integration-card';

/** A client config with the token in the Authorization header, not the URL. */
function mcpClientConfig(serverUrl: string, token: string): string {
  return JSON.stringify(
    { mcpServers: { eavesy: { type: 'http', url: serverUrl, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}

/** Keys for the Eavesy API and for AI apps that can't sign in: make one, see them, revoke them. */
export function ApiKeysCard({ onError }: { onError: (message: string | null) => void }) {
  const [tokens, setTokens] = useState<McpToken[]>([]);
  const [config, setConfig] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [allowWrite, setAllowWrite] = useState(false);

  useEffect(() => {
    void fetch('/api/mcp-tokens')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : []))
      .then((value) => setTokens(parseMcpTokens(value)))
      .catch(() => onError('Could not load your API keys.'));
  }, [onError]);

  const create = async () => {
    setBusy(true);
    onError(null);
    try {
      const response = await fetch('/api/mcp-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'AI assistant', scopes: allowWrite ? ['read', 'write'] : ['read'] }),
      });
      if (!response.ok) throw new Error('Could not create the key');
      const created: unknown = await response.json();
      const serverUrl = isRecord(created) ? optionalString(created.serverUrl) : undefined;
      const token = isRecord(created) ? optionalString(created.token) : undefined;
      if (!serverUrl || !token) throw new Error('Server returned an invalid key');
      setConfig(mcpClientConfig(serverUrl, token));
      setKey(token);
      setCopied(false);
      const refreshed = await fetch('/api/mcp-tokens');
      if (!refreshed.ok) throw new Error('Could not refresh your API keys');
      setTokens(parseMcpTokens(await refreshed.json()));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not create the key.');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    onError(null);
    try {
      const response = await fetch('/api/mcp-tokens', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error('Could not revoke the key');
      setTokens((current) => current.filter((token) => token.id !== id));
      setConfig(null);
      setKey(null);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : 'Could not revoke the key.');
    }
  };

  const copy = async () => {
    if (!config) return;
    try {
      await navigator.clipboard.writeText(config);
      setCopied(true);
    } catch {
      onError('Could not copy it. Select the text and copy it yourself.');
    }
  };

  return (
    <IntegrationCard
      icon={<KeyRound />}
      name="API keys"
      blurb="For the Eavesy API, and AI apps that can’t sign in"
      status={tokens.length ? { text: `${tokens.length} ${tokens.length === 1 ? 'key' : 'keys'}`, tone: 'on' } : undefined}
      action={
        <>
          <label className="hidden items-center gap-1.5 text-xs text-ev-ink-2 sm:flex">
            <input type="checkbox" checked={allowWrite} onChange={(event) => setAllowWrite(event.target.checked)} />
            Allow writes
          </label>
          <button type="button" onClick={() => void create()} disabled={busy} className={appButton('secondary', 'sm')}>
            {busy ? 'Creating…' : 'New key'}
          </button>
        </>
      }
    >
      {config ? (
        <AppAlert tone="success">
          <p className="text-xs font-medium">Copy this now. The key isn’t shown again.</p>
          <div className="mt-2 flex items-start gap-2">
            <textarea
              readOnly
              value={config}
              rows={config.split('\n').length}
              wrap="off"
              aria-label="New MCP configuration"
              className="min-w-0 flex-1 resize-none rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-2 py-1 font-mono text-xs text-ev-ink"
            />
            <button type="button" onClick={() => void copy()} className={appButton('secondary', 'sm')}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          {key ? (
            <p className="mt-2 text-xs">
              For the API, send <code className="font-mono">Authorization: Bearer {key}</code>.{' '}
              <a href={`${MCP_URL}/v1/openapi.json`} className="underline">OpenAPI spec</a>
            </p>
          ) : null}
          <p aria-live="polite" className="sr-only">{copied ? 'Copied to clipboard.' : ''}</p>
        </AppAlert>
      ) : null}
      {tokens.length ? (
        <ul className="divide-y divide-ev-line rounded-[var(--ev-r-ctl)] border border-ev-line">
          {tokens.map((token) => (
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
                  <span className="block text-xs text-ev-warn-ink">Uses the old URL setup, which is being retired. Make a new key.</span>
                ) : null}
              </span>
              <button type="button" onClick={() => void revoke(token.id)} className={appButton('ghost', 'sm')}>Revoke</button>
            </li>
          ))}
        </ul>
      ) : null}
    </IntegrationCard>
  );
}
