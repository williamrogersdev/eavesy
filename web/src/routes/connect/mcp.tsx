import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { isRecord, optionalString } from '@/lib/json';
import { useSignOut } from '@/lib/use-sign-out';
import { resolveActor } from '@/server/auth';

const isSignedIn = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    await resolveActor();
    return true;
  } catch {
    return false;
  }
});

const PARAM_KEYS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state'] as const;
type Params = Partial<Record<(typeof PARAM_KEYS)[number], string>>;

export const Route = createFileRoute('/connect/mcp')({
  validateSearch: (search: Record<string, unknown>): Params =>
    Object.fromEntries(
      PARAM_KEYS.flatMap((key) => (typeof search[key] === 'string' ? [[key, search[key]]] : [])),
    ),
  beforeLoad: async ({ location }) => {
    if (!(await isSignedIn())) {
      throw redirect({ href: `/sign-in?redirect_url=${encodeURIComponent(location.href)}` });
    }
  },
  head: () => ({
    meta: [
      { title: 'Connect an AI assistant to Eavesy' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: ConnectMcpPage,
});

interface ConsentRequest {
  clientName: string;
  redirectHost: string;
  canWrite: boolean;
}

function ConnectMcpPage() {
  const params = Route.useSearch();
  const signOut = useSignOut();
  const [email, setEmail] = useState<string | null>(null);
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [allowWrite, setAllowWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = new URLSearchParams(params).toString();

  useEffect(() => {
    void fetch('/api/me')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .then((value) => { if (isRecord(value)) setEmail(optionalString(value.email) ?? null); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    void fetch(`/api/oauth/authorize?${query}`)
      .then(async (response): Promise<{ ok: boolean; value: unknown }> => ({
        ok: response.ok,
        value: await response.json().catch(() => null),
      }))
      .then(({ ok, value }) => {
        if (!isRecord(value)) throw new Error('Something went wrong. Please try again.');
        if (!ok) throw new Error(`This app can't connect: ${optionalString(value.error) ?? 'the request is invalid'}.`);
        setRequest({
          clientName: optionalString(value.clientName) ?? 'An app',
          redirectHost: optionalString(value.redirectHost) ?? '',
          canWrite: Array.isArray(value.scopes) && value.scopes.includes('write'),
        });
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.'));
  }, [query]);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params, decision, scopes: allowWrite ? ['read', 'write'] : ['read'] }),
      });
      const value: unknown = await response.json().catch(() => null);
      const redirectTo = isRecord(value) ? optionalString(value.redirectTo) : undefined;
      if (!redirectTo) throw new Error('Something went wrong. Please try again.');
      window.location.assign(redirectTo);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  };

  const switchAccount = () => {
    void signOut({ redirectUrl: `/sign-in?redirect_url=${encodeURIComponent(`/connect/mcp?${query}`)}` });
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ev-well px-4">
      <div className="w-full max-w-sm rounded-[var(--ev-r-panel)] border border-ev-line bg-ev-paper p-8 text-center shadow-[var(--ev-e-2)]">
        <BrandMark size={40} className="mx-auto" />
        <h1 className="mt-5 text-lg font-semibold">
          {request ? `Connect ${request.clientName} to Eavesy?` : 'Connect an AI assistant'}
        </h1>
        {request ? (
          <>
            <p className="mt-2 text-sm text-ev-ink-2">
              It will be able to search and read your meetings, dictations and action items, and send you
              messages on your Mac if you turn that on in the Eavesy app.
            </p>
            {request.redirectHost ? (
              <p className="mt-2 text-xs text-ev-ink-2">
                You’ll be sent back to <span className="font-round">{request.redirectHost}</span>
              </p>
            ) : null}
            {request.canWrite ? (
              <label className="mt-4 flex items-start gap-2 rounded-[var(--ev-r-pop)] bg-ev-well p-3 text-left text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowWrite}
                  onChange={(event) => setAllowWrite(event.target.checked)}
                />
                <span>Also let it write, such as sending text to your devices.</span>
              </label>
            ) : null}
          </>
        ) : null}
        {email ? (
          <p className="mt-5 text-sm">
            Signed in as <span className="font-medium">{email}</span>
          </p>
        ) : null}
        {error ? <p role="alert" className="mt-4 text-sm text-ev-warn-ink">{error}</p> : null}
        {request ? (
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => void decide('deny')}
              disabled={busy}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-[var(--ev-r-pop)] border border-ev-line text-sm font-medium hover:bg-[var(--ev-hover)] disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void decide('approve')}
              disabled={busy}
              className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-ev-coat font-round text-sm font-bold text-ev-on-coat shadow-[var(--ev-e-2)] hover:bg-ev-coat-hover disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Allow
            </button>
          </div>
        ) : null}
        <button type="button" onClick={switchAccount} className="mt-3 text-xs text-ev-ink-2 hover:text-ev-ink">
          Use a different account
        </button>
      </div>
    </main>
  );
}
