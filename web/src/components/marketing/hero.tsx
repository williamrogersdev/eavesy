import { ArrowRight, Check } from 'lucide-react';
import { Kbd } from '@/components/launcher/ui';
import { HudPreview, LauncherPreview } from './launcher-preview';
import { DownloadButton, SecondaryButton } from './ui';

export function Hero() {
  return (
    <section className="ev-roofline relative -mt-[68px] px-6 pb-24 pt-[124px] sm:pb-28 sm:pt-[148px]">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
        <div className="flex flex-col items-center text-center lg:items-start lg:text-left">
          <p className="font-round text-[13px] font-semibold uppercase tracking-[0.08em] text-ev-ink-2">
            Context capture for Mac
          </p>

          <h1 className="mt-4 text-balance font-round text-[42px] font-bold leading-[1.04] sm:leading-[1.02] tracking-[-0.035em] text-ev-ink sm:text-6xl lg:text-[56px] xl:text-[60px]">
            Drop it in.
            <br />
            <span className="bg-[linear-gradient(transparent_64%,var(--ev-brand-soft)_64%)]">Paste it to your AI.</span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-ev-ink-2">
            Eavesy keeps the things you&apos;d otherwise re-explain (clipboard text and
            images, screenshots, dictation, recordings) as files and reusable text on your
            Mac. Copy it into Claude, Cursor or ChatGPT, or let an agent read synced recording text
            over hosted MCP.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <DownloadButton className="px-6 py-3 text-[15px]" />
            <SecondaryButton href="/how-it-works" className="px-5 py-3 text-[15px]">
              See how it works
              <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </SecondaryButton>
          </div>

          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-round text-[13px] font-semibold text-ev-ink-2 lg:justify-start">
            {['Free', 'Plain Markdown files on your Mac', 'Open source', 'macOS 13+ on Apple Silicon'].map((item) => (
              <li key={item} className="inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5 text-ev-leaf" strokeWidth={2.5} /> {item}
              </li>
            ))}
          </ul>
        </div>

        <div className="animate-fade-up relative [animation-delay:120ms]">
          <LauncherPreview />
          <HudPreview
            className="absolute -bottom-16 left-1/2 hidden -translate-x-1/2 sm:block lg:bottom-10 lg:-left-24 lg:translate-x-0"
            words={['…so the plan is we ship on Thursday and', 'ask Sam for the deck']}
          />
          <p className="mt-6 text-center font-round text-[13px] font-semibold text-ev-ink-2 sm:mt-24 lg:mt-6">
            Hold <Kbd keys="⌘⇧D" /> and talk. Set Talk to fn in Settings if you prefer.
          </p>
        </div>
      </div>
    </section>
  );
}
