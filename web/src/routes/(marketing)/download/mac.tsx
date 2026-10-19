import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { Apple, AudioLines, Camera, Check, Clapperboard, Copy, FolderOpen, Users } from 'lucide-react';
import { Bubble, Mascot } from '@/components/launcher/ui';
import { LauncherPreview } from '@/components/marketing/launcher-preview';
import { GithubMark } from '@/components/github-mark';
import { siteConfig } from '@/lib/site';
import { useEffect, useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { seoHead } from '@/lib/seo-head';
import { objectExists } from '@/server/r2';

const DMG_KEY = process.env.MAC_DMG_R2_KEY ?? 'downloads/mac/eavesy-latest.dmg';

const DMG_URL =
  (import.meta.env.VITE_MAC_DMG_URL as string | undefined) ??
  '/api/downloads/mac/latest';

const checkDownloadAvailable = createServerFn({ method: 'GET' }).handler(
  async () => {
    if (import.meta.env.VITE_MAC_DMG_URL) return { available: true };
    return { available: await objectExists(DMG_KEY) };
  },
);

export const Route = createFileRoute('/(marketing)/download/mac')({
  validateSearch: (search: Record<string, unknown>): { start?: 1 } =>
    search.start === 1 || search.start === '1' ? { start: 1 } : {},
  loader: async () => checkDownloadAvailable(),
  head: () =>
    seoHead({
      title: 'Download Eavesy for Mac',
      description: 'Free and open source for Mac. Talk, record meetings and your screen, and keep it all as Markdown your AI can use.',
      path: '/download/mac',
    }),
  component: DownloadMacPage,
});

type Device = 'unknown' | 'mac' | 'other';

function detectDevice(): Device {
  const ua = navigator.userAgent;
  if (/Macintosh|Mac OS X/.test(ua) && navigator.maxTouchPoints <= 1) return 'mac';
  return 'other';
}

function DownloadMacPage() {
  const { available } = Route.useLoaderData();
  const { start } = Route.useSearch();
  const [device, setDevice] = useState<Device>('unknown');
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const detected = detectDevice();
    setDevice(detected);
    if (start && available && detected === 'mac') {
      setStarted(true);
      window.location.assign(DMG_URL);
    }
  }, [start, available]);

  return (
    <main>
      <section className="ev-roofline">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-20 pt-14 lg:grid-cols-[1.05fr_1fr] lg:pt-20">
          <div>
            <div className="flex items-end gap-3">
              <Mascot size={64} state={started ? 'happy' : 'idle'} />
              <Bubble tail="left" className="mb-4">
                {started ? 'On its way. See you in Applications.' : 'Hi! I live in your menu bar.'}
              </Bubble>
            </div>
            <h1 className="mt-6 text-balance font-round text-4xl font-extrabold tracking-tight text-ev-ink sm:text-5xl">
              {started ? 'Your download is starting' : 'Eavesy for Mac'}
            </h1>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-ev-ink-2">
              {started
                ? 'Open Eavesy.dmg from your Downloads, then drag Eavesy into Applications.'
                : 'Talk, record a meeting or your screen, grab a screenshot. Everything lands as Markdown on your Mac, ready to paste to your AI. Free and open source.'}
            </p>

            <div className="mt-8">
              {!available ? (
                <p className="rounded-[var(--ev-r-pop)] bg-ev-well px-4 py-3 text-sm text-ev-ink-2">
                  The download is being updated. Check back in a few minutes.
                </p>
              ) : device === 'other' ? (
                <div className="max-w-md rounded-[var(--ev-r-pop)] bg-ev-raised p-4 text-sm shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)]">
                  <p className="font-round font-bold text-ev-ink">Eavesy runs on Mac.</p>
                  <p className="mt-1 text-ev-ink-2">
                    Open <span className="font-semibold text-ev-ink">eavesy.com/download/mac</span> on your Mac to install it,
                    or record from any browser with the <Link href="/app/record" className="font-semibold text-ev-slate underline underline-offset-2">web recorder</Link>.
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <a
                    href={DMG_URL}
                    className="inline-flex h-12 items-center gap-2.5 rounded-full bg-ev-slate px-6 font-round text-base font-bold text-ev-on-slate shadow-[var(--ev-e-2)] transition hover:bg-ev-slate-hover active:scale-[0.98]"
                  >
                    <Apple className="h-5 w-5" />
                    {started ? 'Download again' : 'Download for Mac'}
                  </a>
                  <a
                    href={siteConfig.github}
                    className="inline-flex h-12 items-center gap-2 rounded-full px-5 font-round text-sm font-bold text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] transition hover:bg-[var(--ev-hover)]"
                  >
                    <GithubMark className="h-4 w-4" /> View source
                  </a>
                </div>
              )}
              <p className="mt-3 font-round text-[13px] font-semibold text-ev-ink-3">
                Apple silicon · macOS 13 or later · Notarized, updates itself
              </p>
            </div>

            <div className="mt-8 max-w-md">
              <p className="font-round text-[13px] font-bold text-ev-ink-2">Prefer Homebrew?</p>
              <CopyCommand text={BREW} />
            </div>
          </div>

          <div className="relative">
            <LauncherPreview />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="font-round text-2xl font-extrabold text-ev-ink">Up and running in a minute</h2>
        <ol className="mt-6 grid gap-4 md:grid-cols-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="rounded-[var(--ev-r-panel)] bg-ev-raised p-5 shadow-[0_0_0_1px_var(--ev-line),var(--ev-e-2)]">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-ev-slate-soft font-round text-sm font-extrabold text-ev-slate">
                {i + 1}
              </span>
              <h3 className="mt-3 font-round text-[15px] font-bold text-ev-ink">{step.title}</h3>
              <p className="mt-1 text-sm leading-relaxed text-ev-ink-2">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="bg-ev-well">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="font-round text-2xl font-extrabold text-ev-ink">What it captures</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {MODES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-[var(--ev-r-panel)] bg-ev-raised p-5 shadow-[var(--ev-e-2)]">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-ev-paper text-ev-ink-2 shadow-[0_0_0_1px_var(--ev-line)]">
                  <Icon size={18} strokeWidth={1.75} />
                </span>
                <h3 className="mt-3 font-round text-[15px] font-bold text-ev-ink">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-ev-ink-2">{body}</p>
              </div>
            ))}
          </div>
          <p className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-ev-ink-2">
            <span className="inline-flex items-center gap-1.5"><FolderOpen className="h-4 w-4" /> Saved under ~/Eavesy as plain Markdown and audio</span>
            <span className="inline-flex items-center gap-1.5"><GithubMark className="h-3.5 w-3.5" /> Apache-2.0, <a href={siteConfig.github} className="font-semibold text-ev-slate underline underline-offset-2">on GitHub</a></span>
          </p>
        </div>
      </section>

      <div className="py-10 text-center text-sm text-ev-ink-2">
        Already installed? <Link href="/sign-in" className="font-semibold text-ev-slate underline underline-offset-2">Sign in</Link> to sync your library.
      </div>
    </main>
  );
}

const BREW = 'brew install --cask williamrogersdev/eavesy/eavesy';

const STEPS = [
  { title: 'Install', body: 'Open Eavesy.dmg and drag Eavesy into Applications.' },
  { title: 'Allow the mic', body: 'Setup asks for the microphone. Screen Recording and the rest are optional.' },
  { title: 'Sign in, if you like', body: 'Free sign-in adds cloud transcripts, briefs and sync. You can stay local.' },
  { title: 'Press ⌘⇧Space', body: 'Opens Eavesy from anywhere. ⌘⇧D starts Talk and types where your cursor is.' },
];

const MODES = [
  { icon: AudioLines, title: 'Talk', body: 'Dictate into any app, or keep a voice note. Your mic only.' },
  { icon: Users, title: 'Meeting', body: 'Both sides of a call, from your mic and system audio. No bot joins.' },
  { icon: Clapperboard, title: 'Video', body: 'Your screen with its sound and your voice, for walkthroughs and bug reports.' },
  { icon: Camera, title: 'Screenshots and clipboard', body: 'Screenshots, pasted text and dropped files, all in one searchable history.' },
];

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex h-10 items-center gap-2 rounded-full bg-ev-well pl-4 pr-1 text-sm text-ev-ink">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="inline-flex h-8 items-center gap-1 rounded-full bg-ev-raised px-3 font-round text-xs font-bold text-ev-ink shadow-[var(--ev-e-2)] hover:bg-ev-paper"
        aria-label="Copy Homebrew command"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
