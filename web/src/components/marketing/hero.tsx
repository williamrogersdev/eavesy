import { ArrowRight, Check } from 'lucide-react';
import { Bubble, Kbd, Mascot } from '@/components/launcher/ui';
import { HudPreview, LauncherPreview } from './launcher-preview';
import { DownloadButton, SecondaryButton } from './ui';

export function Hero() {
  return (
    <section className="ev-roofline relative -mt-[68px] px-6 pb-24 pt-[124px] sm:pb-28 sm:pt-[148px]">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_1fr] lg:gap-10">
        <div className="animate-fade-up flex flex-col items-center text-center lg:items-start lg:text-left">
          <div className="flex items-end gap-3">
            <Mascot size={72} state="idle" />
            <Bubble tail="left" className="mb-5 max-w-[240px]">
              Hi, I&apos;m Eavesy. I live up here and write things down for you.
            </Bubble>
          </div>

          <h1 className="mt-8 text-balance font-round text-[42px] font-extrabold leading-[1.04] sm:leading-[1.02] tracking-tight text-ev-ink sm:text-6xl lg:text-[56px] xl:text-[60px]">
            Drop it in.
            <br />
            <span className="text-ev-slate">Paste it to your AI.</span>
          </h1>

          <p className="mt-6 max-w-xl text-pretty text-lg leading-relaxed text-ev-ink-2">
            Eavesy keeps the things you&apos;d otherwise re-explain (clipboard text and
            images, screenshots, dictation, recordings) as clean Markdown on your
            Mac. Copy it into Claude, Cursor or ChatGPT, or let an agent read it
            over MCP.
          </p>

          <div className="mt-9 flex flex-col items-center gap-3 sm:flex-row">
            <DownloadButton className="px-6 py-3 text-[15px]" />
            <SecondaryButton href="/how-it-works" className="px-5 py-3 text-[15px]">
              See how it works
              <ArrowRight className="h-4 w-4" strokeWidth={2} />
            </SecondaryButton>
          </div>

          <ul className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 font-round text-[13px] font-semibold text-ev-ink-2 lg:justify-start">
            {['Free', 'Plain Markdown on your Mac', 'macOS 13+ on Apple Silicon'].map((item) => (
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
            Hold <Kbd keys="fn" /> and talk. Let go to paste.
          </p>
        </div>
      </div>
    </section>
  );
}
