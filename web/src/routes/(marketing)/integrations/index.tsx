import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import {
  INTEGRATIONS,
  INTEGRATION_CATEGORIES,
} from '@/content/integrations';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/integrations/')({
  head: () =>
    seoHead({
      title: 'Integrations',
      description:
        'Use Eavesy with AI assistants, call apps, and Markdown notes. Learn which workflows use local files, copy and paste, or authorized hosted MCP.',
      path: '/integrations',
    }),
  component: IntegrationsPage,
});

function IntegrationsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Integrations"
        title="Take context from your Mac to the tools you use"
        description="Capture audio from call apps, keep Markdown in your notes, or hand context to an AI assistant. Each guide explains the connection: local capture, manual copy, files, or hosted MCP."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Integrations', path: '/integrations' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="flex flex-col gap-14">
          {INTEGRATION_CATEGORIES.map((category) => {
            const items = INTEGRATIONS.filter((i) => i.category === category);
            if (items.length === 0) return null;
            return (
              <div key={category}>
                <h2 className="text-sm font-semibold text-ev-ink-2">
                  {category}
                </h2>
                <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {items.map((integration) => (
                    <Link
                      key={integration.slug}
                      href={`/integrations/${integration.slug}`}
                      className="group flex flex-col rounded-2xl border border-ev-line bg-ev-raised p-6 transition hover:border-ev-line-strong hover:bg-ev-well"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ev-well text-sm font-semibold text-ev-ink">
                          {integration.name.slice(0, 1)}
                        </span>
                        <h3 className="font-semibold text-ev-ink">{integration.name}</h3>
                      </div>
                      <p className="mt-4 flex-1 text-sm leading-relaxed text-ev-ink-2">
                        {integration.tagline}
                      </p>
                      <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-ev-coat transition group-hover:gap-2">
                        See how <ArrowRight className="h-4 w-4" />
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
