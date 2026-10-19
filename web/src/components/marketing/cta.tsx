import { Bubble, Mascot } from '@/components/launcher/ui';
import { DownloadButton } from './ui';

export function DownloadCTA() {
  return (
    <section className="px-6 py-24">
      <div className="ev-tile relative mx-auto flex max-w-5xl flex-col items-center overflow-hidden px-8 pb-16 pt-14 text-center">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(60%_100%_at_50%_0%,var(--ev-honey-soft),transparent)]" />
        <div className="relative flex flex-col items-center">
          <Bubble tail="bottom" className="mb-3">
            Room for one more up here.
          </Bubble>
          <Mascot size={88} state="happy" />
        </div>
        <h2 className="relative mt-6 text-balance font-round text-4xl font-extrabold tracking-tight text-ev-ink sm:text-5xl">
          Stop re-explaining. Start with <span className="text-ev-slate">full context</span>.
        </h2>
        <p className="relative mx-auto mt-4 max-w-md text-ev-ink-2">
          Drop in what matters and get Markdown you can hand to any AI. Free for Mac.
        </p>
        <div className="relative mt-8">
          <DownloadButton className="px-6 py-3 text-[15px]" />
        </div>
        <p className="relative mt-4 font-round text-xs font-semibold text-ev-ink-3">Free · macOS 13+ on Apple Silicon · No credit card</p>
      </div>
    </section>
  );
}
