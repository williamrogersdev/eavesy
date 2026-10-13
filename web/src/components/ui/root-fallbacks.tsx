import type { ErrorComponentProps } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Link } from '@/components/ui/app-link';

function FallbackShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg rounded-3xl border border-border bg-muted/30 p-6 text-center shadow-xl shadow-black/5 sm:p-10">
        {children}
      </div>
    </main>
  );
}

export function RootError({ error, reset }: ErrorComponentProps) {
  return (
    <FallbackShell>
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-danger-soft text-danger">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">We couldn&apos;t load this page</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Your data has not been changed. Try the page again, or return home and continue from there.
      </p>
      <div className="mt-6 flex flex-col justify-center gap-2 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"
        >
          <RefreshCw className="h-4 w-4" /> Try again
        </button>
        <a href="/" className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-semibold hover:bg-muted">
          <ArrowLeft className="h-4 w-4" /> Return home
        </a>
      </div>
      {import.meta.env.DEV ? (
        <details className="mt-7 rounded-xl border border-border bg-background p-3 text-left text-xs text-muted-foreground">
          <summary className="font-medium text-foreground">Development details</summary>
          <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono">{error instanceof Error ? error.message : String(error)}</pre>
        </details>
      ) : null}
    </FallbackShell>
  );
}

export function RootNotFound() {
  return (
    <FallbackShell>
      <BrandMark className="mx-auto h-12 w-12" />
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-accent">404</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">That page isn&apos;t here</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        The address may be outdated, or the page may have moved.
      </p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground hover:opacity-90">
        <ArrowLeft className="h-4 w-4" /> Back to Eavesy
      </Link>
    </FallbackShell>
  );
}
