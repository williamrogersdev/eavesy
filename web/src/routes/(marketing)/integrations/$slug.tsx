import { createFileRoute, notFound } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { INTEGRATIONS, getIntegration } from '@/content/integrations';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { JsonLd, faqSchema } from '@/components/seo/json-ld';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/integrations/$slug')({
  loader: ({ params }) => {
    const integration = getIntegration(params.slug);
    if (!integration) throw notFound();
    return { integration };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seoHead({
          title: `${loaderData.integration.name} — ${loaderData.integration.tagline}`,
          description: loaderData.integration.description,
          path: `/integrations/${loaderData.integration.slug}`,
        })
      : {},
  component: IntegrationDetailPage,
});

function IntegrationDetailPage() {
  const { integration } = Route.useLoaderData();

  const others = INTEGRATIONS.filter(
    (i) => i.slug !== integration.slug && i.category === integration.category,
  ).slice(0, 3);

  return (
    <main className="flex flex-1 flex-col">
      {integration.faqs && integration.faqs.length > 0 && (
        <JsonLd schema={faqSchema(integration.faqs)} />
      )}

      <PageHero
        eyebrow={integration.category}
        title={integration.tagline}
        description={integration.description}
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Integrations', path: '/integrations' },
            { name: integration.name, path: `/integrations/${integration.slug}` },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="max-w-3xl">
          <h2 className="text-2xl font-extrabold tracking-tight text-ev-ink">
            How it works with {integration.name}
          </h2>
          <ol className="mt-8 flex flex-col gap-px">
            {integration.steps.map((step, i) => (
              <li
                key={step}
                className="flex gap-5 border-b border-ev-line py-5 last:border-0"
              >
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-ev-line text-sm font-semibold text-ev-ink">
                  {i + 1}
                </span>
                <p className="leading-relaxed text-ev-ink">{step}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {integration.faqs && integration.faqs.length > 0 && (
        <section className="border-t border-ev-line px-6 py-16">
          <Container className="max-w-3xl">
            <h2 className="text-2xl font-extrabold tracking-tight text-ev-ink">
              Frequently asked
            </h2>
            <dl className="mt-8 divide-y divide-ev-line">
              {integration.faqs.map((f) => (
                <div key={f.q} className="py-5">
                  <dt className="font-medium text-ev-ink">{f.q}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-ev-ink-2">{f.a}</dd>
                </div>
              ))}
            </dl>
          </Container>
        </section>
      )}

      {others.length > 0 && (
        <section className="border-t border-ev-line px-6 py-16">
          <Container>
            <h2 className="text-sm font-semibold text-ev-ink-2">
              More {integration.category.toLowerCase()} integrations
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {others.map((o) => (
                <Link
                  key={o.slug}
                  href={`/integrations/${o.slug}`}
                  className="group flex items-center justify-between rounded-xl border border-ev-line bg-ev-raised p-4 transition hover:border-ev-line-strong hover:bg-ev-well"
                >
                  <span className="text-sm font-medium text-ev-ink">{o.name}</span>
                  <ArrowRight className="h-4 w-4 text-ev-ink-2 transition group-hover:text-ev-slate" />
                </Link>
              ))}
            </div>
          </Container>
        </section>
      )}

      <CTASection />
    </main>
  );
}
