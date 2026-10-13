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
          <h2 className="text-2xl font-semibold tracking-tight text-white">
            How it works with {integration.name}
          </h2>
          <ol className="mt-8 flex flex-col gap-px">
            {integration.steps.map((step, i) => (
              <li
                key={step}
                className="flex gap-5 border-b border-white/[0.06] py-5 last:border-0"
              >
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-white/15 text-sm font-semibold text-white/70">
                  {i + 1}
                </span>
                <p className="leading-relaxed text-white/70">{step}</p>
              </li>
            ))}
          </ol>
        </Container>
      </section>

      {integration.faqs && integration.faqs.length > 0 && (
        <section className="border-t border-white/[0.06] px-6 py-16">
          <Container className="max-w-3xl">
            <h2 className="text-2xl font-semibold tracking-tight text-white">
              Frequently asked
            </h2>
            <dl className="mt-8 divide-y divide-white/[0.06]">
              {integration.faqs.map((f) => (
                <div key={f.q} className="py-5">
                  <dt className="font-medium text-white">{f.q}</dt>
                  <dd className="mt-2 text-sm leading-relaxed text-white/55">{f.a}</dd>
                </div>
              ))}
            </dl>
          </Container>
        </section>
      )}

      {others.length > 0 && (
        <section className="border-t border-white/[0.06] px-6 py-16">
          <Container>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-white/50">
              More {integration.category.toLowerCase()} integrations
            </h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              {others.map((o) => (
                <Link
                  key={o.slug}
                  href={`/integrations/${o.slug}`}
                  className="group flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.02] p-4 transition hover:border-white/20 hover:bg-white/[0.04]"
                >
                  <span className="text-sm font-medium text-white">{o.name}</span>
                  <ArrowRight className="h-4 w-4 text-white/50 transition group-hover:text-white/60" />
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
