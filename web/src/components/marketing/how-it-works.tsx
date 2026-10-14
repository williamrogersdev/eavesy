import { Command } from 'lucide-react';
import { STEPS } from './content';
import { SectionLabel } from './ui';
import { cn } from '@/lib/utils';

export function HowItWorks({ showHeader = true }: { showHeader?: boolean } = {}) {
  return (
    <section id="how" className="border-t border-white/[0.06] bg-white/[0.015] px-6 py-24">
      {showHeader && (
        <div className="mx-auto max-w-2xl text-center">
          <SectionLabel><Command className="h-3.5 w-3.5 text-accent" /> How it works</SectionLabel>
          <h2 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">Drop it in. Copy it out.</h2>
        </div>
      )}
      <div className={cn('relative mx-auto grid max-w-5xl gap-5 md:grid-cols-3', showHeader && 'mt-16')}>
        {STEPS.map((s) => (
          <div key={s.n} className="relative rounded-2xl border border-white/10 bg-[#0b0b11] p-7">
            <div className="flex items-center justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/[0.06] text-accent">
                <s.icon className="h-5 w-5" />
              </div>
              <span className="font-mono text-2xl font-bold text-white/50">{s.n}</span>
            </div>
            <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm text-white/55">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
