import { Command } from 'lucide-react';
import { STEPS } from './content';
import { SectionLabel } from './ui';
import { cn } from '@/lib/utils';

export function HowItWorks({ showHeader = true }: { showHeader?: boolean } = {}) {
  return (
    <section id="how" className="ev-shelf-band px-6 py-24">
      {showHeader && (
        <div className="mx-auto max-w-2xl text-center">
          <SectionLabel><Command className="h-3.5 w-3.5 text-ev-slate" /> How it works</SectionLabel>
          <h2 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl">Drop it in. Copy it out.</h2>
        </div>
      )}
      <div className={cn('relative mx-auto grid max-w-5xl gap-5 md:grid-cols-3', showHeader && 'mt-16')}>
        {STEPS.map((s) => (
          <div key={s.n} className="relative rounded-2xl border border-ev-line bg-ev-raised p-7 shadow-[var(--ev-e-2)]">
            <div className="flex items-center justify-between">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-ev-honey-soft text-ev-honey-ink">
                <s.icon className="h-5 w-5" />
              </div>
              <span className="font-round text-2xl font-bold tabular-nums text-ev-ink-2">{s.n}</span>
            </div>
            <h3 className="mt-5 text-lg font-semibold">{s.title}</h3>
            <p className="mt-2 text-sm text-ev-ink-2">{s.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
