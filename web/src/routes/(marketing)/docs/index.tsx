import { createFileRoute } from '@tanstack/react-router';
import { ArrowRight, Bot, Download, Mail, Rocket } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { getDocsByCategory } from '@/lib/content';
import { categoryMeta } from '@/lib/docs-meta';
import { Breadcrumbs } from '@/components/marketing/page-chrome';
import { GithubMark } from '@/components/github-mark';
import { Mascot } from '@/components/launcher/ui';
import { siteConfig } from '@/lib/site';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/docs/')({
  head: () =>
    seoHead({
      title: 'Documentation',
      description:
        'How to use Eavesy: install the Mac app, capture with Talk, Meeting, Video and Screenshot, read your files, and connect AI agents over MCP.',
      path: '/docs',
    }),
  component: DocsHomePage,
});

const QUICK_LINKS = [
  {
    href: '/docs/getting-started',
    title: 'Getting started',
    desc: 'What Eavesy does and the fastest path to your first capture.',
    icon: Rocket,
  },
  {
    href: '/docs/installing-the-mac-app',
    title: 'Install the Mac app',
    desc: 'Requirements, DMG or Homebrew, permissions, and signing in.',
    icon: Download,
  },
  {
    href: '/docs/connect-mcp',
    title: 'Connect an agent',
    desc: 'Add Eavesy to your agent by URL over MCP.',
    icon: Bot,
  },
];

const BUTTON =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-5 font-round text-sm font-bold transition duration-150 active:scale-[0.97]';

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

      <div className="relative overflow-hidden rounded-[28px] bg-ev-raised p-7 shadow-[inset_0_0_0_1px_var(--ev-line)] sm:p-10">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-ev-honey-soft blur-3xl"
        />
        <div className="relative flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="font-round text-3xl font-extrabold tracking-tight text-ev-ink sm:text-4xl">
              Eavesy docs
            </h1>
            <p className="mt-3 max-w-xl leading-relaxed text-ev-ink-2">
              How to capture with the Mac app and the web, where your files
              live, and how to hand them to an AI agent.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link
                href="/docs/installing-the-mac-app"
                className={`${BUTTON} bg-ev-slate text-ev-on-slate shadow-[var(--ev-e-2)] hover:bg-ev-slate-hover`}
              >
                Install the Mac app
                <ArrowRight className="h-4 w-4" />
              </Link>
              <a
                href={siteConfig.github}
                className={`${BUTTON} text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] hover:bg-ev-well`}
              >
                <GithubMark className="h-4 w-4" />
                View on GitHub
              </a>
            </div>
          </div>
          <Mascot size={72} state="idle" className="hidden flex-none sm:block" />
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {QUICK_LINKS.map(({ href, title, desc, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group rounded-2xl bg-ev-raised p-5 shadow-[inset_0_0_0_1px_var(--ev-line)] transition hover:bg-ev-well"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ev-slate-soft text-ev-slate">
              <Icon className="h-4.5 w-4.5" />
            </span>
            <h2 className="mt-3 flex items-center gap-1.5 font-round font-bold text-ev-ink">
              {title}
              <ArrowRight className="h-3.5 w-3.5 text-ev-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ev-slate" />
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-ev-ink-2">{desc}</p>
          </Link>
        ))}
      </div>

      {groups.length === 0 ? (
        <p className="mt-10 text-ev-ink-2">Documentation is coming soon.</p>
      ) : (
        <section aria-labelledby="docs-sections" className="mt-14">
          <h2 id="docs-sections" className="font-round text-xl font-extrabold text-ev-ink">
            Browse by topic
          </h2>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            {groups.map((group) => {
              const { icon: Icon, blurb } = categoryMeta(group.category);
              return (
                <div
                  key={group.category}
                  className="flex flex-col rounded-2xl bg-ev-raised p-5 shadow-[inset_0_0_0_1px_var(--ev-line)]"
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-ev-well text-ev-ink">
                      <Icon className="h-4.5 w-4.5" />
                    </span>
                    <div className="min-w-0">
                      <h3 className="font-round font-bold text-ev-ink">{group.category}</h3>
                      <p className="mt-0.5 text-sm leading-relaxed text-ev-ink-2">{blurb}</p>
                    </div>
                  </div>
                  <ul className="mt-4 flex flex-col gap-px border-t border-ev-line pt-3">
                    {group.docs.map((doc) => (
                      <li key={doc.slug}>
                        <Link
                          href={`/docs/${doc.slug}`}
                          className="group flex min-h-9 items-center justify-between gap-2 rounded-xl px-3 text-sm text-ev-ink transition hover:bg-ev-well"
                        >
                          {doc.frontmatter.title}
                          <ArrowRight className="h-3.5 w-3.5 flex-none text-ev-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ev-slate" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="mt-14 flex flex-col gap-5 rounded-[28px] bg-ev-slate p-7 text-ev-on-slate sm:flex-row sm:items-center sm:justify-between sm:p-9">
        <div className="flex items-start gap-4">
          <GithubMark className="mt-1 h-7 w-7 flex-none" />
          <div>
            <h2 className="font-round text-xl font-extrabold">Eavesy is open source</h2>
            <p className="mt-1.5 max-w-lg text-sm leading-relaxed opacity-85">
              The Mac app, the web app, the MCP server and these docs are all in
              one repository under the Apache License 2.0. Read the code, run
              your own server, or send a fix.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 sm:flex-none">
          <a
            href={siteConfig.github}
            className={`${BUTTON} bg-ev-on-slate text-ev-slate hover:opacity-90`}
          >
            <GithubMark className="h-4 w-4" />
            View the repo
          </a>
          <Link
            href="/docs/open-source"
            className={`${BUTTON} text-ev-on-slate shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ev-on-slate)_40%,transparent)] hover:bg-ev-slate-hover`}
          >
            Self-hosting
          </Link>
        </div>
      </section>

      <section className="mt-4 flex flex-col gap-4 rounded-2xl bg-ev-well p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-round text-lg font-bold text-ev-ink">Still stuck?</h2>
          <p className="mt-1 text-sm text-ev-ink-2">
            Check <Link href="/docs/troubleshooting" className="text-ev-slate underline underline-offset-2">troubleshooting</Link>,
            open an issue, or email us.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            href={`${siteConfig.github}/issues`}
            className={`${BUTTON} bg-ev-raised text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] hover:bg-ev-paper`}
          >
            <GithubMark className="h-4 w-4" />
            Open an issue
          </a>
          <a
            href={`mailto:${siteConfig.supportEmail}`}
            className={`${BUTTON} text-ev-ink hover:bg-ev-raised`}
          >
            <Mail className="h-4 w-4" />
            Email support
          </a>
        </div>
      </section>
    </div>
  );
}
