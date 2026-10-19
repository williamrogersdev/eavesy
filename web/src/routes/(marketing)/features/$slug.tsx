import { createFileRoute, notFound } from '@tanstack/react-router';
import { ArrowRight, Check } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { FEATURE_PAGES, getFeature } from '@/content/features';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { JsonLd, faqSchema } from '@/components/seo/json-ld';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/features/$slug')({
  loader: ({ params }) => {
    const feature = getFeature(params.slug);
    if (!feature) throw notFound();
    return { slug: feature.slug };
  },
  head: ({ loaderData }) => {
    const feature = loaderData ? getFeature(loaderData.slug) : undefined;
    return feature
      ? seoHead({
          title: feature.title,
          description: feature.description,
          path: `/features/${feature.slug}`,
        })
      : {};
  },
  component: FeatureDetailPage,
});

function FeatureDetailPage() {
  const { slug } = Route.useLoaderData();
  const feature = getFeature(slug);
  if (!feature) throw notFound();

  const related = (feature.related ?? [])
    .map((s) => FEATURE_PAGES.find((f) => f.slug === s))
    .filter((f): f is NonNullable<typeof f> => Boolean(f));

  return (
    <main className="flex flex-1 flex-col">
      {feature.faqs && feature.faqs.length > 0 && (
        <JsonLd schema={faqSchema(feature.faqs)} />
      )}

      <PageHero
        eyebrow={feature.availability === 'coming-soon' ? `${feature.eyebrow} · Coming soon` : feature.eyebrow}
        title={feature.title}
        description={feature.intro}
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Features', path: '/features' },
            { name: feature.name, path: `/features/${feature.slug}` },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container>
          <div className="grid gap-4 sm:grid-cols-2">
            {feature.highlights.map((h) => (
              <div
                key={h.title}
                className="rounded-2xl border border-ev-line bg-ev-raised p-6"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-ev-slate-soft text-ev-slate">
                    <Check className="h-3.5 w-3.5" strokeWidth={3} />
                  </span>
                  <div>
                    <h2 className="font-semibold text-ev-ink">{h.title}</h2>
                    <p className="mt-1.5 text-sm leading-relaxed text-ev-ink-2">
                      {h.body}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Container>
      </section>

      {feature.faqs && feature.faqs.length > 0 && (
        <section className="border-t border-ev-line px-6 py-16">
          <Container className="max-w-3xl">
            <h2 className="text-2xl font-extrabold tracking-tight text-ev-ink">
              Frequently asked
            </h2>
            <dl className="mt-8 divide-y divide-ev-line">
              {feature.faqs.map((f) => (
                <div key={f.q} className="py-5">
                  <dt className="font-medium text-ev-ink">{f.q}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-ev-ink-2">{f.a}</dd>
                </div>
              ))}
            </dl>
          </Container>
        </section>
      )}

      {related.length > 0 && (
        <section className="border-t border-ev-line px-6 py-16">
          <Container>
            <h2 className="text-sm font-semibold text-ev-ink-2">
              Related features
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {related.map((r) => {
                const Icon = r.icon;
                return (
                  <Link
                    key={r.slug}
                    href={`/features/${r.slug}`}
                    className="group flex items-center gap-3 rounded-xl border border-ev-line bg-ev-raised p-4 transition hover:border-ev-line-strong hover:bg-ev-well"
                  >
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-ev-slate-soft text-ev-slate">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm font-medium text-ev-ink">{r.name}</span>
                    <ArrowRight className="ml-auto h-4 w-4 text-ev-ink-2 transition group-hover:text-ev-slate" />
                  </Link>
                );
              })}
            </div>
          </Container>
        </section>
      )}

      <CTASection />
    </main>
  );
}
