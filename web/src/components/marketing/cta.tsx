import { DownloadButton } from './ui';

export function DownloadCTA() {
  return (
    <section className="px-6 py-24">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-[32px] border border-white/10 px-8 py-16 text-center">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-accent/10" />
        <div className="pointer-events-none absolute left-1/2 top-0 -z-10 h-64 w-[600px] -translate-x-1/2 rounded-full bg-accent/15 blur-[100px]" />
        <h2 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          Stop re-explaining. Start with <span className="text-brand-gradient">full context</span>.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-white/60">
          Open the launcher, drop in what matters, and get Markdown you can hand to any AI. Free for Mac.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <DownloadButton className="px-5 py-3" />
        </div>
        <p className="mt-4 text-xs text-white/50">Free · macOS 13+ on Apple Silicon · No credit card</p>
      </div>
    </section>
  );
}
