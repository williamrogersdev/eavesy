import { cn } from '@/lib/utils';
import { BENTO, type BentoItem } from './content';

export function Bento() {
  return (
    <section className="px-6 py-20 sm:py-24">
      <div className="mx-auto mb-12 max-w-2xl text-center">
        <p className="font-round text-sm font-bold text-ev-coat">What you can drop in</p>
        <h2 className="mt-4 text-balance text-3xl font-extrabold tracking-tight sm:text-5xl">
          One place for everything your AI needs to see.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-sm leading-relaxed text-ev-ink-2 sm:text-base">
          Eavesy holds the text, images, and recordings your prompt would otherwise
          lose, as Markdown you can copy in a second.
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
        'group relative overflow-hidden rounded-2xl border border-ev-line p-6 transition hover:-translate-y-0.5 hover:border-ev-line-strong',
        highlight ? 'bg-ev-coat-soft' : 'bg-ev-raised',
        span && 'lg:col-span-2',
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-ev-well text-ev-coat">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm text-ev-ink-2">{body}</p>
    </div>
  );
}
