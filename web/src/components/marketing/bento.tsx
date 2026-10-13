import { cn } from '@/lib/utils';
import { BENTO, type BentoItem } from './content';

export function Bento() {
  return (
    <section className="px-6 py-20 sm:py-24">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">What you can capture</p>
        <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-5xl">
          One context layer for the work your AI cannot see.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-white/55 sm:text-base">
          Eavesy covers the moments where a text prompt loses the screen, the conversation,
          or the sequence of events.
        </p>
      </div>
      <div className="mx-auto grid max-w-5xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {BENTO.map((item) => (
          <BentoCard key={item.title} item={item} />
        ))}
      </div>
    </section>
  );
}

function BentoCard({ item }: { item: BentoItem }) {
  const { icon: Icon, title, body, span, highlight } = item;
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl border border-white/10 p-6 transition hover:-translate-y-0.5 hover:border-white/20',
        highlight ? 'bg-accent/[0.06]' : 'bg-white/[0.02]',
        span && 'lg:col-span-2',
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/[0.06] text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-white/55">{body}</p>
    </div>
  );
}
