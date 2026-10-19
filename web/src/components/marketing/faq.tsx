import { ChevronDown } from 'lucide-react';
import { FAQS } from './content';
import { SectionLabel } from './ui';

export function Faq() {
  return (
    <section id="faq" className="ev-shelf-band px-6 py-24">
      <div className="mx-auto max-w-2xl text-center">
        <SectionLabel>FAQ</SectionLabel>
        <h2 className="mt-5 text-4xl font-extrabold tracking-tight sm:text-5xl">Questions, answered.</h2>
      </div>
      <div className="mx-auto mt-12 max-w-2xl divide-y divide-ev-line overflow-hidden rounded-2xl border border-ev-line bg-ev-raised">
        {FAQS.map((f) => (
          <details key={f.q} className="group px-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-medium">
              {f.q}
              <ChevronDown className="h-4 w-4 shrink-0 text-ev-ink-2 transition-transform group-open:rotate-180" />
            </summary>
            <p className="pb-5 text-sm leading-relaxed text-ev-ink-2">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
