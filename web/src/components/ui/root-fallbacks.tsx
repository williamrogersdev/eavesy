import type { ErrorComponentProps } from '@tanstack/react-router';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Bubble, Mascot } from '@/components/launcher/ui';
import { appButton } from '@/components/ui/app-page';
import { cn } from '@/lib/utils';
import { Link } from '@/components/ui/app-link';
import { reportClientError } from '@/lib/observability/browser';
import { useEffect } from 'react';

function FallbackShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="ev-roofline flex min-h-dvh items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg rounded-[24px] bg-ev-raised p-6 text-center shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-3)] sm:p-10">
        {children}
      </div>
    </main>
  );
}

export function RootError({ error, reset }: ErrorComponentProps) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <FallbackShell>
      <div className="flex justify-center"><Mascot size={64} state="confused" /></div>
      <h1 className="mt-5 font-round text-2xl font-extrabold text-ev-ink">We couldn&apos;t load this page</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ev-ink-2">
        Your data has not been changed. Try the page again, or return home and continue from there.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className={appButton('primary')}
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
        <a href="/" className={appButton('secondary')}>
          <ArrowLeft className="h-4 w-4" /> Return home
        </a>
      </div>
      {import.meta.env.DEV ? (
        <details className="mt-7 rounded-[var(--ev-r-pop)] bg-ev-well p-3 text-left text-xs text-ev-ink-2">
          <summary className="font-round font-bold text-ev-ink">Development details</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono">{error instanceof Error ? error.message : String(error)}</pre>
        </details>
      ) : null}
    </FallbackShell>
  );
}

export function RootNotFound() {
  return (
    <FallbackShell>
      <div className="flex items-end justify-center gap-2">
        <Mascot size={64} state="confused" />
        <Bubble tail="left" className="mb-4">Hmm, nothing here.</Bubble>
      </div>
      <h1 className="mt-5 font-round text-2xl font-extrabold text-ev-ink">That page isn&apos;t here</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-ev-ink-2">
        The address may be outdated, or the page may have moved.
      </p>
      <Link href="/" className={cn(appButton('primary'), 'mt-6')}>
        <ArrowLeft className="h-4 w-4" /> Back to Eavesy
      </Link>
    </FallbackShell>
  );
}
