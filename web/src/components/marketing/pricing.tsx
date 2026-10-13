import { Check, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PLANS, type Plan } from './content';
import { DownloadButton, SectionLabel } from './ui';
import { siteConfig } from '@/lib/site';

export function Pricing({ showHeader = true }: { showHeader?: boolean } = {}) {
  return (
    <section id="pricing" className="px-6 py-24">
      {showHeader && (
        <div className="mx-auto max-w-2xl text-center">
          <SectionLabel><Zap className="h-3.5 w-3.5 text-accent" /> Pricing</SectionLabel>
          <h2 className="mt-5 text-4xl font-bold tracking-tight sm:text-5xl">Start free. Upgrade when it sticks.</h2>
        </div>
      )}
      <div className={cn('mx-auto grid max-w-5xl items-start gap-5 md:grid-cols-3', showHeader && 'mt-14')}>
        {PLANS.map((plan) => (
          <PlanCard key={plan.name} plan={plan} />
        ))}
      </div>
    </section>
  );
}

function PlanCta({ cta }: { cta: Plan['cta'] }) {
  switch (cta) {
    case 'download':
      return <DownloadButton className="w-full" />;
    case 'sales':
      return (
        <a
          href={`mailto:${siteConfig.contactEmail}?subject=Eavesy%20Team`}
          className="inline-flex w-full items-center justify-center rounded-xl border border-white/15 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/5"
        >
          Contact sales
        </a>
      );
  }
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div
      className={cn(
        'relative rounded-3xl border p-7',
        plan.featured
          ? 'border-accent/40 bg-accent/[0.06] shadow-xl shadow-accent/10'
          : 'border-white/10 bg-white/[0.02]',
      )}
    >
      {plan.featured ? (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-action px-3 py-1 text-[11px] font-semibold text-white">
          Most popular
        </span>
      ) : null}
      <div className="text-sm font-medium text-white/60">{plan.name}</div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
        {plan.period ? <span className="text-sm text-white/50">{plan.period}</span> : null}
      </div>
      <div className="mt-1 text-sm text-white/55">{plan.tagline}</div>
      <ul className="mt-6 space-y-3">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5 text-sm text-white/75">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-white/80" strokeWidth={2.5} />
            {f}
          </li>
        ))}
      </ul>
      <div className="mt-7"><PlanCta cta={plan.cta} /></div>
    </div>
  );
}
