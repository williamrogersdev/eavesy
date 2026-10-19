import { INTEGRATIONS } from './content';

export function Marquee() {
  const row = [...INTEGRATIONS, ...INTEGRATIONS];
  return (
    <section className="ev-shelf-band py-8">
      <p className="mb-6 text-center text-xs font-medium text-ev-ink-2">
        Capture from the tools you use. Send context to the tools you choose.
      </p>
      <div className="relative overflow-hidden [mask-image:linear-gradient(to_right,transparent,#000_12%,#000_88%,transparent)]">
        <div className="flex w-max animate-marquee gap-10 pr-10">
          {row.map((name, i) => (
            <span
              key={i}
              aria-hidden={i >= INTEGRATIONS.length ? true : undefined}
              className="whitespace-nowrap text-lg font-medium text-ev-ink-2"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
