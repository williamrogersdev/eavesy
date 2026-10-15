import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { FEATURE_PAGES } from '@/content/features';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/features/')({
  head: () =>
    seoHead({
      title: 'Features',
      description:
        'Save clipboard text, screenshots, dictation and recordings as Markdown context for any AI agent, with search, MCP access and files you own.',
      path: '/features',
    }),
  component: FeaturesPage,
});

function FeaturesPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Features"
        title="Everything you need to give your AI context"
        description="Eavesy is a local assistant: you drop in text, screenshots, dictation, and recordings, and it keeps them as clean Markdown you can paste into any agent, all in files you own. Here's how each piece works."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Features', path: '/features' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURE_PAGES.map((feature) => {
              const Icon = feature.icon;
              return (
                <Link
                  key={feature.slug}
                  href={`/features/${feature.slug}`}
                  className="group flex flex-col rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition hover:border-white/20 hover:bg-white/[0.04]"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/15 text-accent">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h2 className="mt-5 text-lg font-semibold text-white">
                    {feature.name}
                  </h2>
                  {feature.availability === 'coming-soon' ? (
                    <span className="mt-2 w-fit rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-white/55">
                      Coming soon
                    </span>
                  ) : null}
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-white/55">
                    {feature.description}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent transition group-hover:gap-2">
                    Learn more <ArrowRight className="h-4 w-4" />
                  </span>
                </Link>
              );
            })}
          </div>
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
