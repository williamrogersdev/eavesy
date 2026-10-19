import { Link } from '@/components/ui/app-link';
import { ChevronRight } from 'lucide-react';
import { JsonLd, breadcrumbSchema } from '@/components/seo/json-ld';
import { DownloadButton, SectionLabel } from './ui';
import { cn } from '@/lib/utils';
import { Mascot } from '@/components/launcher/ui';

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
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-ev-ink-2">
        {items.map((item, i) => {
          const last = i === items.length - 1;
          return (
            <li key={item.path} className="flex items-center gap-1.5">
              {last ? (
                <span className="text-ev-ink">{item.name}</span>
              ) : (
                <Link href={item.path} className="transition hover:text-ev-ink">
                  {item.name}
                </Link>
              )}
              {!last && <ChevronRight className="h-3.5 w-3.5 text-ev-ink-2" />}
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
    <section className="ev-roofline relative -mt-[68px] overflow-hidden pb-14 pt-[116px]">
      <Container className="relative">
        {eyebrow && (
          <div className="mb-5">
            <SectionLabel>{eyebrow}</SectionLabel>
          </div>
        )}
        <h1 className="max-w-3xl text-balance font-round text-4xl font-extrabold tracking-tight text-ev-ink sm:text-5xl">
          {title}
        </h1>
        {description && (
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-ev-ink-2">
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
    <section className="ev-shelf-band px-6 py-20">
      <Container className="flex flex-col items-center gap-6 text-center">
        <Mascot size={64} state="idle" />
        <h2 className="max-w-2xl text-balance font-round text-3xl font-extrabold tracking-tight text-ev-ink sm:text-4xl">
          {title}
        </h2>
        <p className="max-w-xl text-ev-ink-2">{subtitle}</p>
        <div className="flex flex-col items-center gap-3 sm:flex-row">
          <DownloadButton className="px-5 py-3" />
        </div>
      </Container>
    </section>
  );
}
