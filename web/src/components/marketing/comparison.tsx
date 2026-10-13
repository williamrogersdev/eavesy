import { Check, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/brand-mark';
import { COMPARISON } from './content';
import { SectionLabel } from './ui';

export function Comparison() {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionLabel><ShieldCheck className="h-3.5 w-3.5 text-accent" /> The difference</SectionLabel>
        <h2 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">No bots. No lock-in.</h2>
      </div>
      <div className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-2xl border border-white/10">
        <div className="hidden grid-cols-3 border-b border-white/10 bg-white/[0.03] text-sm font-semibold sm:grid">
          <div className="p-4 text-white/50" />
          <div className="p-4 text-white/50">Meeting bots</div>
          <div className="flex items-center gap-1.5 p-4 text-white">
            <BrandMark className="h-5 w-5" />
            Eavesy
          </div>
        </div>
        {COMPARISON.map((row, i) => (
          <div key={row.label} className={cn('border-t border-white/[0.07] p-4 text-sm first:border-0 sm:grid sm:grid-cols-3 sm:border-0 sm:p-0', i % 2 && 'bg-white/[0.015]')}>
            <div className="pb-3 font-medium text-white/70 sm:p-4">{row.label}</div>
            <div className="rounded-lg bg-white/[0.025] p-3 text-white/55 sm:rounded-none sm:bg-transparent sm:p-4">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-white/50 sm:hidden">Meeting bots</span>
              {row.them}
            </div>
            <div className="mt-2 flex items-start gap-2 rounded-lg bg-accent/[0.06] p-3 text-white/85 sm:mt-0 sm:rounded-none sm:bg-transparent sm:p-4">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-white/80" strokeWidth={2.5} />
              <span><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-accent sm:hidden">Eavesy</span>{row.us}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
