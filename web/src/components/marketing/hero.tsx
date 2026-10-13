import { ArrowRight, Check } from 'lucide-react';
import { AppWindow } from './app-window';
import { DownloadButton, SecondaryButton } from './ui';

export function Hero() {
  return (
    <section className="relative px-6 pb-24 pt-20 sm:pt-28">
      <HeroBackdrop />

      <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
        <span className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium text-white/70 backdrop-blur">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--signal)] opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--signal)]" />
          </span>
          Screen + voice → structured context for any AI
        </span>

        <h1 className="animate-fade-up mt-6 text-balance text-5xl font-bold leading-[1.05] tracking-tight sm:text-6xl md:text-7xl">
          Record the work.
          <br />
          <span className="text-brand-gradient">Brief your AI.</span>
        </h1>

        <p className="animate-fade-up mt-6 max-w-xl text-pretty text-lg text-white/60">
          Capture a walkthrough, meeting, or bug reproduction once. Eavesy turns
          the screen and conversation into a concise Markdown brief, transcript,
          and source files you can use with Claude, Cursor, ChatGPT, or any agent.
        </p>

        <div className="animate-fade-up mt-9 flex flex-col items-center gap-3 sm:flex-row">
          <DownloadButton className="px-5 py-3" />
          <SecondaryButton href="/how-it-works" className="px-5 py-3">
            See how it works
            <ArrowRight className="h-4 w-4" />
          </SecondaryButton>
        </div>

        <div className="animate-fade-up mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-white/55">
          {['Free', 'macOS 13+ on Apple Silicon', 'No meeting bot'].map((item) => (
            <span key={item} className="inline-flex items-center gap-1.5">
              <Check className="h-3.5 w-3.5 text-white/60" /> {item}
            </span>
          ))}
        </div>
      </div>

      <div className="animate-fade-up mt-16 [animation-delay:120ms]">
        <AppWindow />
      </div>
    </section>
  );
}

function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div className="absolute left-1/2 top-[-12%] h-[520px] w-[900px] -translate-x-1/2 animate-aurora rounded-full bg-accent/15 blur-[140px]" />
      <div className="absolute left-[15%] top-[5%] h-[360px] w-[360px] animate-aurora rounded-full bg-white/[0.04] blur-[120px] [animation-delay:-6s]" />
      <div className="absolute right-[12%] top-[8%] h-[360px] w-[360px] animate-aurora rounded-full bg-white/[0.04] blur-[120px] [animation-delay:-12s]" />
      <div className="absolute inset-0 text-white/[0.07] [mask-image:radial-gradient(ellipse_55%_50%_at_50%_0%,#000_30%,transparent_75%)] bg-dot-grid" />
    </div>
  );
}
