import type { ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { Bubble, Mascot } from '@/components/launcher/ui';
import { GithubMark } from '@/components/github-mark';
import { siteConfig } from '@/lib/site';
import { BrandMark } from '@/components/brand-mark';
import { Link } from '@/components/ui/app-link';
import { appButton } from '@/components/ui/app-page';

const BENEFITS = [
  'Transcripts and summaries for your voice notes and meetings',
  'Your library in sync between the Mac app and the web',
  'Hand any of it to Claude, Cursor or ChatGPT, or over MCP',
];

export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh w-full bg-ev-paper lg:grid-cols-[minmax(360px,0.85fr)_minmax(560px,1.15fr)]">
      <aside className="ev-roofline relative hidden overflow-hidden border-r border-ev-line px-10 py-10 lg:flex lg:flex-col">
        <Link href="/" className="relative flex w-fit items-center gap-2 font-round text-[16px] font-extrabold text-ev-ink">
          <BrandMark size={30} />
          Eavesy
        </Link>
        <div className="relative my-auto max-w-md py-14">
          <div className="flex items-end gap-3">
            <Mascot size={88} state="idle" />
            <Bubble tail="left" className="mb-6">
              Hi, I&apos;m Eavesy. Sign in and I&apos;ll keep your notes in sync.
            </Bubble>
          </div>
          <h1 className="mt-8 text-balance font-round text-4xl font-extrabold tracking-tight text-ev-ink xl:text-[44px]">
            Drop it in. <span className="text-ev-slate">Paste it to your AI.</span>
          </h1>
          <ul className="mt-8 space-y-3">
            {BENEFITS.map((benefit) => (
              <li key={benefit} className="flex items-start gap-3 text-[15px] text-ev-ink-2">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ev-leaf-soft text-ev-leaf">
                  <Check className="h-3 w-3" strokeWidth={3} />
                </span>
                {benefit}
              </li>
            ))}
          </ul>
        </div>
        <a
          href={siteConfig.github}
          className="relative flex w-fit items-center gap-2 font-round text-xs font-semibold text-ev-ink-2 hover:text-ev-slate"
        >
          <GithubMark className="h-3.5 w-3.5" /> Open source · Plain files on your Mac · No meeting bot
        </a>
      </aside>

      <section className="flex min-h-dvh flex-col bg-ev-paper">
        <div className="flex h-16 items-center justify-between px-4 sm:px-7 lg:hidden">
          <Link href="/" className="flex items-center gap-2 font-round font-extrabold">
            <BrandMark size={32} />
            Eavesy
          </Link>
          <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-ev-ink-2 hover:text-ev-ink">
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
      <div className="w-full max-w-md rounded-[20px] bg-ev-raised p-6 text-center shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)] sm:p-8">
        <BrandMark size={44} className="mx-auto" />
        <h1 className="mt-5 font-round text-xl font-extrabold">Authentication isn&apos;t configured</h1>
        <p className="mt-2 text-sm leading-relaxed text-ev-ink-2">
          You can&apos;t {action} in this environment yet. The public site is still available, and the setup guide explains what is required to enable accounts.
        </p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Link href="/" className={appButton('primary')}>
            Return home
          </Link>
          <Link href="/docs/getting-started" className={appButton('secondary')}>
            Read the setup guide
          </Link>
        </div>
      </div>
    </AuthFrame>
  );
}
