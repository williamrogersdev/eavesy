import { Check, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Mascot } from '@/components/launcher/ui';
import { COMPARISON } from './content';
import { SectionLabel } from './ui';

export function Comparison() {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionLabel><ShieldCheck className="h-3.5 w-3.5 text-ev-coat" /> The difference</SectionLabel>
        <h2 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl">Local files. No bots. No lock-in.</h2>
      </div>
      <div className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-2xl border border-ev-line">
        <div className="hidden grid-cols-3 border-b border-ev-line bg-ev-raised text-sm font-semibold sm:grid">
          <div className="p-4 text-ev-ink-2" />
          <div className="p-4 text-ev-ink-2">Meeting bots</div>
          <div className="flex items-center gap-1.5 p-4 text-ev-ink">
            <Mascot size={20} state="idle" />
            Eavesy
          </div>
        </div>
        {COMPARISON.map((row, i) => (
          <div key={row.label} className={cn('border-t border-ev-line p-4 text-sm first:border-0 sm:grid sm:grid-cols-3 sm:border-0 sm:p-0', i % 2 && 'bg-ev-raised')}>
            <div className="pb-3 font-medium text-ev-ink sm:p-4">{row.label}</div>
            <div className="rounded-lg bg-ev-raised p-3 text-ev-ink-2 sm:rounded-none sm:bg-transparent sm:p-4">
              <span className="mb-1 block text-[11px] font-semibold text-ev-ink-2 sm:hidden">Meeting bots</span>
              {row.them}
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-ev-coat-soft p-3 text-ev-ink sm:mt-0 sm:rounded-none sm:bg-transparent sm:p-4">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-ev-ink" strokeWidth={2.5} />
              <span><span className="mb-1 block text-[11px] font-semibold text-ev-coat sm:hidden">Eavesy</span>{row.us}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
