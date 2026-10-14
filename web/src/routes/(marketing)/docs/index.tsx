import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Rocket, Bot, Download, MessageSquare } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { getDocsByCategory } from '@/lib/content';
import { categoryMeta } from '@/lib/docs-meta';
import { Breadcrumbs } from '@/components/marketing/page-chrome';
import { siteConfig } from '@/lib/site';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/docs/')({
  head: () =>
    seoHead({
      title: 'Documentation',
      description:
        'Learn how to drop text, screenshots, dictation, and recordings into Eavesy and paste the Markdown into any AI agent or connect over MCP.',
      path: '/docs',
    }),
  component: DocsHomePage,
});

const QUICK_LINKS = [
  {
    href: '/docs/getting-started',
    title: 'Getting started',
    desc: 'What Eavesy is and the fastest path to your first capture.',
    icon: Rocket,
  },
  {
    href: '/docs/context-for-agents',
    title: 'Context for AI agents',
    desc: 'Paste Markdown into Claude, Cursor, or ChatGPT, or connect over MCP.',
    icon: Bot,
  },
  {
    href: '/download/mac',
    title: 'Install the Mac app',
    desc: 'Paste, screenshot, dictate, or record, with files saved straight to your disk.',
    icon: Download,
  },
];

function DocsHomePage() {
  const groups = getDocsByCategory();

  return (
    <div>
      <Breadcrumbs
        items={[
          { name: 'Home', path: '/' },
          { name: 'Docs', path: '/docs' },
        ]}
      />

      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.02] p-8 sm:p-10">
        <div
          aria-hidden
          className="animate-aurora pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-accent/10 blur-3xl"
        />
        <div className="relative">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">
            Documentation
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            Everything you need to use Eavesy
          </h1>
          <p className="mt-3 max-w-2xl text-white/55">
            Eavesy is a local assistant for AI context. Learn how to drop things
            in, copy clean Markdown into any agent, connect over MCP, and keep
            every file you own.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {QUICK_LINKS.map(({ href, title, desc, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-white/20 hover:bg-white/[0.04]"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-accent">
              <Icon className="h-4.5 w-4.5" />
            </div>
            <h3 className="mt-3 flex items-center gap-1.5 font-semibold text-white">
              {title}
              <ArrowRight className="h-3.5 w-3.5 text-white/50 transition group-hover:translate-x-0.5 group-hover:text-white/60" />
            </h3>
            <p className="mt-1 text-sm leading-relaxed text-white/55">{desc}</p>
          </Link>
        ))}
      </div>

      {groups.length === 0 ? (
        <p className="mt-10 text-white/55">Documentation is coming soon.</p>
      ) : (
        <div className="mt-14 flex flex-col gap-12">
          {groups.map((group) => {
            const { icon: Icon, blurb } = categoryMeta(group.category);
            return (
              <section key={group.category}>
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-white/70">
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-white">
                      {group.category}
                    </h2>
                    <p className="text-sm text-white/55">{blurb}</p>
                  </div>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {group.docs.map((doc) => (
                    <Link
                      key={doc.slug}
                      href={`/docs/${doc.slug}`}
                      className="group rounded-2xl border border-white/10 bg-white/[0.02] p-5 transition hover:border-white/20 hover:bg-white/[0.04]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-semibold text-white">
                          {doc.frontmatter.title}
                        </h3>
                        <ArrowRight className="h-4 w-4 flex-none text-white/50 transition group-hover:translate-x-0.5 group-hover:text-white/60" />
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-white/55">
                        {doc.frontmatter.description}
                      </p>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}

      <div className="mt-16 flex flex-col items-start gap-4 rounded-3xl border border-white/10 bg-white/[0.02] p-8 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
            <MessageSquare className="h-5 w-5 text-accent" />
            Still stuck?
          </h2>
          <p className="mt-1 text-sm text-white/55">
            Can&rsquo;t find what you need? We read every message.
          </p>
        </div>
        <a
          href={`mailto:${siteConfig.supportEmail}`}
          className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/[0.08]"
        >
          Email support
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}
