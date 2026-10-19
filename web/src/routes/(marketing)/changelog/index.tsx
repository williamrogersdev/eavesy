import { createFileRoute } from '@tanstack/react-router';
import { getAllChangelog } from '@/lib/content';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { MdxContent } from '@/components/mdx/mdx-content';
import { seoHead } from '@/lib/seo-head';
import { formatDate } from '@/lib/format';

export const Route = createFileRoute('/(marketing)/changelog/')({
  head: () =>
    seoHead({
      title: 'Changelog',
      description:
        'What’s new in Eavesy — new features, improvements, and fixes, newest first.',
      path: '/changelog',
    }),
  component: ChangelogPage,
});

function ChangelogPage() {
  const entries = getAllChangelog();

  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Changelog"
        title="What’s new in Eavesy"
        description="Every notable change, newest first. Follow along as Eavesy gets faster, smarter, and more yours."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Changelog', path: '/changelog' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="max-w-3xl">
          {entries.length === 0 ? (
            <p className="text-ev-ink-2">No entries yet.</p>
          ) : (
            <div className="flex flex-col gap-16">
              {entries.map((entry) => (
                <article key={entry.slug} className="flex flex-col gap-4">
                  <div className="flex flex-wrap items-center gap-3">
                    {entry.frontmatter.version && (
                      <span className="rounded-full border border-ev-line bg-ev-well px-3 py-1 text-xs font-medium text-ev-ink">
                        {entry.frontmatter.version}
                      </span>
                    )}
                    <time
                      dateTime={entry.frontmatter.date}
                      className="text-sm text-ev-ink-2"
                    >
                      {formatDate(entry.frontmatter.date)}
                    </time>
                  </div>
                  <h2 className="text-2xl font-extrabold tracking-tight text-ev-ink">
                    {entry.frontmatter.title}
                  </h2>
                  <MdxContent Component={entry.Component} />
                </article>
              ))}
            </div>
          )}
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
