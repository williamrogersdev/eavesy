import type { ReactNode } from 'react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { BrandMark } from '@/components/brand-mark';
import { Link } from '@/components/ui/app-link';

const BENEFITS = [
  'Capture a workflow, meeting, or quick explanation',
  'Receive a structured brief and full transcript',
  'Use the result with any AI agent',
];

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh w-full bg-background lg:grid-cols-[minmax(360px,0.85fr)_minmax(560px,1.15fr)]">
      <aside className="theme-dark relative hidden overflow-hidden border-r border-white/10 px-10 py-12 lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-dot-grid text-white/[0.045]" />
        <div aria-hidden className="pointer-events-none absolute -left-40 top-1/4 h-96 w-96 rounded-full bg-accent/15 blur-[110px]" />
        <Link href="/" className="relative flex w-fit items-center gap-2.5 font-semibold text-white">
          <BrandMark className="h-8 w-8" />
          Eavesy
        </Link>
        <div className="relative my-auto max-w-md py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Context capture for AI</p>
          <h1 className="mt-5 text-balance text-4xl font-semibold tracking-[-0.035em] text-white xl:text-5xl">
            Stop rebuilding context from memory.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-white/55">
            Record an explanation once. Eavesy turns it into a brief your next agent can use immediately.
          </p>
          <ul className="mt-8 space-y-3">
            {BENEFITS.map((benefit) => (
              <li key={benefit} className="flex items-start gap-3 text-sm text-white/75">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                {benefit}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/35">Private workspace · Portable files · No meeting bot</p>
      </aside>

      <section className="flex min-h-dvh flex-col bg-muted/35">
        <div className="flex h-16 items-center justify-between px-4 sm:px-7 lg:hidden">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <BrandMark className="h-8 w-8" />
            Eavesy
          </Link>
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Home
          </Link>
        </div>
        <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
          {children}
        </div>
      </section>
    </main>
  );
}

export function AuthUnavailable({ action }: { action: 'sign in' | 'create an account' }) {
  return (
    <AuthFrame>
      <div className="w-full max-w-md rounded-2xl border border-border bg-background p-6 text-center shadow-xl shadow-black/5 sm:p-8">
        <BrandMark className="mx-auto h-11 w-11" />
        <h1 className="mt-5 text-xl font-semibold tracking-tight">Authentication isn&apos;t configured</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          You can&apos;t {action} in this environment yet. The public site is still available, and the setup guide explains what is required to enable accounts.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90">
            Return home
          </Link>
          <Link href="/docs/getting-started" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-border px-4 text-sm font-semibold hover:bg-muted">
            Read the setup guide
          </Link>
        </div>
      </div>
    </AuthFrame>
  );
}
