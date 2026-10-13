import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { Apple, Mic, Folder, Zap } from 'lucide-react';
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
      description: 'Free for Mac. Press a hotkey, talk through the work, and get a brief any AI can use.',
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
    <main className="mx-auto flex max-w-2xl flex-col gap-10 px-6 py-16">
      <header className="text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted/40">
          <Apple className="h-6 w-6" />
        </span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight">
          {started ? 'Your download is starting' : 'Eavesy for Mac'}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {started
            ? 'Open Eavesy.dmg from your Downloads, then drag Eavesy into Applications.'
            : 'Press a hotkey, talk through the work, and get a brief and transcript any AI can use. Free.'}
        </p>
      </header>

      {!available ? (
        <p className="text-center text-sm text-muted-foreground">
          The download is being updated. Please check back in a few minutes.
        </p>
      ) : device === 'other' ? (
        <div className="mx-auto max-w-sm rounded-lg border border-border bg-muted/30 p-5 text-center text-sm">
          <p className="font-medium">Eavesy runs on Mac.</p>
          <p className="mt-1 text-muted-foreground">
            Open <span className="font-mono">eavesy.com/download/mac</span> on your Mac to install it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <a
            href={DMG_URL}
            className="inline-flex items-center gap-2.5 rounded-xl bg-action px-6 py-3 text-base font-semibold text-white shadow-lg shadow-action/25 hover:bg-action-hover"
          >
            <Apple className="h-5 w-5" />
            {started ? 'Download again' : 'Download for Mac'}
          </a>
          <p className="text-xs text-muted-foreground">macOS 13 or later · Apple Silicon</p>
        </div>
      )}

      <section className="rounded-lg border border-border p-6 text-sm">
        <h2 className="text-base font-semibold">Getting started</h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-muted-foreground">
          <li>Open Eavesy.dmg and drag Eavesy into Applications.</li>
          <li>Open Eavesy. Setup asks for the microphone; Screen Recording is optional.</li>
          <li>Sign in with one click to get transcripts and briefs (optional, free).</li>
          <li>Press your hotkey to start recording. Files are saved under <code>~/Eavesy/Recordings</code>.</li>
        </ol>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <Card icon={<Mic className="h-4 w-4" />} title="Screen, call audio, mic">
          Records calls, walkthroughs and bug reproductions without adding a meeting bot.
        </Card>
        <Card icon={<Folder className="h-4 w-4" />} title="Files on your disk">
          Every recording is a folder with audio, <code>transcript.md</code> and <code>summary.md</code>.
        </Card>
        <Card icon={<Zap className="h-4 w-4" />} title="One hotkey">
          Start, stop, search and paste from anywhere on your Mac.
        </Card>
      </section>

      <div className="text-center text-sm text-muted-foreground">
        Already installed? <Link href="/sign-in" className="text-foreground underline underline-offset-2">Sign in</Link>
      </div>
    </main>
  );
}

function Card({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span>{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
