import { Check, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SHOWCASES, type Showcase } from './content';
import { SectionLabel } from './ui';
import { ShowcaseVisualFor } from './visuals';

export function FeatureShowcases() {
  return (
    <section id="features" className="px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionLabel>
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Built for AI agents
        </SectionLabel>
        <h2 className="mt-5 text-balance text-4xl font-bold tracking-tight sm:text-5xl">
          The fastest way from <span className="text-brand-gradient">anything</span> to context.
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-white/55">
          A native Mac app that keeps what you save as plain Markdown, so your
          agent gets the full story instead of a vague prompt.
        </p>
      </div>

      <div className="mx-auto mt-20 flex max-w-5xl flex-col gap-24">
        {SHOWCASES.map((s) => (
          <ShowcaseRow key={s.title} showcase={s} />
        ))}
      </div>
    </section>
  );
}

function ShowcaseRow({ showcase }: { showcase: Showcase }) {
  const { icon: Icon, eyebrow, title, body, points, flip, visual } = showcase;
  return (
    <div className="grid items-center gap-10 md:grid-cols-2">
      <div className={cn(flip && 'md:order-2')}>
        <div className="flex items-center gap-2 text-sm font-medium text-accent">
          <Icon className="h-4 w-4" />
          {eyebrow}
        </div>
        <h3 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{title}</h3>
        <p className="mt-4 text-white/55">{body}</p>
        <ul className="mt-6 space-y-2.5">
          {points.map((p) => (
            <li key={p} className="flex items-center gap-2.5 text-sm text-white/75">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-white/80">
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              {p}
            </li>
          ))}
        </ul>
      </div>
      <div className={cn(flip && 'md:order-1')}>
        <ShowcaseVisualFor kind={visual} />
      </div>
    </div>
  );
}
