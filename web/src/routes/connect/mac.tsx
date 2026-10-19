import { createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { isRecord, optionalNumber, optionalString } from '@/lib/json';
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

export const Route = createFileRoute('/connect/mac')({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === 'string' ? search.code : '',
  }),
  beforeLoad: async ({ location }) => {
    if (!(await isSignedIn())) {
      throw redirect({ href: `/sign-in?redirect_url=${encodeURIComponent(location.href)}` });
    }
  },
  head: () => ({
    meta: [
      { title: 'Sign in to Eavesy for Mac' },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
  component: ConnectMacPage,
});

type Phase = 'ready' | 'connecting' | 'done' | 'error';

function ConnectMacPage() {
  const { code } = Route.useSearch();
  const signOut = useSignOut();
  const [email, setEmail] = useState<string | null>(null);
  const [request, setRequest] = useState<{ requestedAt: number; sameNetwork: boolean | null } | null>(null);
  const [phase, setPhase] = useState<Phase>(code ? 'ready' : 'error');
  const [error, setError] = useState<string | null>(code ? null : 'This link is missing its code. Click Sign in in the Eavesy app again.');

  useEffect(() => {
    void fetch('/api/me')
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .then((value) => { if (isRecord(value)) setEmail(optionalString(value.email) ?? null); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!code) return;
    void fetch(`/api/devices/pair?code=${encodeURIComponent(code)}`)
      .then(async (response): Promise<unknown> => (response.ok ? response.json() : null))
      .then((value) => {
        const requestedAt = isRecord(value) ? optionalNumber(value.requestedAt) : undefined;
        if (!isRecord(value) || requestedAt === undefined) return;
        setRequest({ requestedAt, sameNetwork: typeof value.sameNetwork === 'boolean' ? value.sameNetwork : null });
      })
      .catch(() => {});
  }, [code]);

  const connect = async () => {
    setPhase('connecting');
    setError(null);
    try {
      const response = await fetch('/api/devices/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (response.status === 404) throw new Error('This sign-in link expired. Click Sign in in the Eavesy app to get a new one.');
      if (response.status === 409) throw new Error('This Mac is still signed in to another Eavesy account. Sign out in the Eavesy app\'s settings, then click Sign in again.');
      if (!response.ok) throw new Error('Something went wrong. Please try again.');
      setPhase('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong. Please try again.');
      setPhase('error');
    }
  };

  const switchAccount = () => {
    void signOut({ redirectUrl: `/sign-in?redirect_url=${encodeURIComponent(`/connect/mac?code=${encodeURIComponent(code)}`)}` });
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-ev-well px-4">
      <div className="w-full max-w-sm rounded-[var(--ev-r-panel)] border border-ev-line bg-ev-paper p-8 text-center shadow-[var(--ev-e-2)]">
        <BrandMark size={40} className="mx-auto" />
        {phase === 'done' ? (
          <>
            <CheckCircle2 className="mx-auto mt-6 h-8 w-8 text-emerald-500" />
            <h1 className="mt-3 text-lg font-semibold">You&apos;re signed in</h1>
            <p className="mt-2 text-sm text-ev-ink-2">
              Eavesy for Mac is connected{email ? ` to ${email}` : ''}. Head back to the app; you can close this tab.
            </p>
          </>
        ) : (
          <>
            <h1 className="mt-5 text-lg font-semibold">Sign in to Eavesy for Mac</h1>
            <p className="mt-2 text-sm text-ev-ink-2">
              Your recordings will get transcripts and sync to your account.
            </p>
            {email ? (
              <p className="mt-5 text-sm">
                Signed in as <span className="font-medium">{email}</span>
              </p>
            ) : null}
            {request?.sameNetwork === false ? (
              <p role="alert" className="mt-4 flex gap-2 rounded-[var(--ev-r-pop)] bg-amber-500/10 p-3 text-left text-xs text-amber-700 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  This request came from a different network than this browser. Only continue if you just clicked
                  Sign in in Eavesy for Mac yourself. Otherwise someone else&apos;s Mac would get access to your account.
                </span>
              </p>
            ) : null}
            {error ? <p role="alert" className="mt-4 text-sm text-ev-warn-ink">{error}</p> : null}
            {code ? (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={phase === 'connecting'}
                className="mt-5 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-ev-slate font-round text-sm font-bold text-ev-on-slate shadow-[var(--ev-e-2)] hover:bg-ev-slate-hover disabled:opacity-60"
              >
                {phase === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {phase === 'error' ? 'Try again' : 'Continue'}
              </button>
            ) : null}
            <button type="button" onClick={switchAccount} className="mt-3 text-xs text-ev-ink-2 hover:text-ev-ink">
              Use a different account
            </button>
            {code ? (
              <p className="mt-6 font-round text-[11px] tracking-wider text-ev-ink-2">
                {code}
                {request ? ` · requested ${requestedAgo(request.requestedAt)}` : ''}
              </p>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

function requestedAgo(at: number): string {
  const minutes = Math.floor((Date.now() - at) / 60_000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}
