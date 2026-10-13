import { Link } from '@/components/ui/app-link';
import { ChevronRight } from 'lucide-react';
import { JsonLd, breadcrumbSchema } from '@/components/seo/json-ld';
import { DownloadButton, SectionLabel } from './ui';
import { cn } from '@/lib/utils';

export function Container({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mx-auto w-full max-w-6xl px-6', className)}>{children}</div>
  );
}

export interface Crumb {
  name: string;
  path: string;
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <JsonLd schema={breadcrumbSchema(items)} />
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-white/55">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.path} className="flex items-center gap-1.5">
              {last ? (
                <span className="text-white/70">{item.name}</span>
              ) : (
                <Link href={item.path} className="transition hover:text-white">
                  {item.name}
                </Link>
              )}
              {!last && <ChevronRight className="h-3.5 w-3.5 text-white/50" />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHero({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden border-b border-white/[0.06] pb-14 pt-12">
      <div
        aria-hidden
        className="animate-aurora pointer-events-none absolute -top-40 left-1/2 h-[28rem] w-[44rem] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl"
      />
      <Container className="relative">
        {eyebrow && (
          <div className="mb-5">
            <SectionLabel>{eyebrow}</SectionLabel>
          </div>
        )}
        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          {title}
        </h1>
        {description && (
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-white/55">
            {description}
          </p>
        )}
        {children && <div className="mt-8">{children}</div>}
      </Container>
    </section>
  );
}

export function CTASection({
  title = 'Capture it once. Use the context anywhere.',
  subtitle = 'Free for Mac. Press a hotkey, talk through the work, and get a brief any AI can use.',
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <section className="border-t border-white/[0.06] px-6 py-20">
      <Container className="flex flex-col items-center gap-6 text-center">
        <h2 className="max-w-2xl text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          {title}
        </h2>
        <p className="max-w-xl text-white/55">{subtitle}</p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <DownloadButton className="px-5 py-3" />
        </div>
      </Container>
    </section>
  );
}
