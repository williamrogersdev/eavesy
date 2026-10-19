import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { Pencil } from 'lucide-react';
import { getAllDocs, getDoc } from '@/lib/content';
import { extractToc } from '@/lib/toc';
import { categoryMeta, docEditUrl, DOC_REDIRECTS } from '@/lib/docs-meta';
import { siteConfig } from '@/lib/site';
import { Breadcrumbs } from '@/components/marketing/page-chrome';
import { DocToc } from '@/components/marketing/doc-toc';
import { DocPager, type PagerLink } from '@/components/marketing/doc-pager';
import { MdxContent } from '@/components/mdx/mdx-content';
import { GithubMark } from '@/components/github-mark';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/docs/$slug')({
  loader: ({ params }) => {
    const moved = DOC_REDIRECTS[params.slug];
    if (moved) {
      throw redirect({ to: '/docs/$slug', params: { slug: moved }, statusCode: 301 });
    }
    const doc = getDoc(params.slug);
    if (!doc) throw notFound();

    const toc = extractToc(doc.content);
    const all = getAllDocs();
    const index = all.findIndex((d) => d.slug === params.slug);
    const toLink = (i: number): PagerLink | undefined =>
      all[i] ? { slug: all[i].slug, title: all[i].frontmatter.title } : undefined;

    return {
      slug: doc.slug,
      frontmatter: doc.frontmatter,
      toc,
      prev: toLink(index - 1),
      next: toLink(index + 1),
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seoHead({
          title: loaderData.frontmatter.title,
          description: loaderData.frontmatter.description,
          path: `/docs/${loaderData.slug}`,
        })
      : {},
  component: DocPage,
});

function DocPage() {
  const { slug, frontmatter, toc, prev, next } = Route.useLoaderData();
  const doc = getDoc(slug);
  if (!doc) throw notFound();
  const { icon: CategoryIcon } = categoryMeta(frontmatter.category);

  return (
    <div className="grid gap-12 xl:grid-cols-[1fr_13rem]">
      <article className="min-w-0">
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Docs', path: '/docs' },
            { name: frontmatter.title, path: `/docs/${slug}` },
          ]}
        />
        <header className="mb-10 border-b border-ev-line pb-8">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-ev-slate-soft px-3 py-1 font-round text-xs font-bold text-ev-slate">
            <CategoryIcon className="h-3.5 w-3.5" />
            {frontmatter.category}
          </div>
          <h1 className="mt-4 font-round text-3xl font-extrabold tracking-tight text-ev-ink sm:text-4xl">
            {frontmatter.title}
          </h1>
          <p className="mt-3 max-w-2xl text-lg leading-relaxed text-ev-ink-2">
            {frontmatter.description}
          </p>
        </header>

        <div className="[&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto sm:[&_table]:table">
          <MdxContent Component={doc.Component} />
        </div>

        <div className="mt-14 flex flex-col gap-3 rounded-2xl bg-ev-well p-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-ev-ink-2">
            These docs are open source. Spotted something wrong or missing?
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={docEditUrl(slug)}
              className="inline-flex min-h-9 items-center gap-2 rounded-full bg-ev-raised px-4 font-round text-sm font-bold text-ev-ink shadow-[inset_0_0_0_1px_var(--ev-line-strong)] transition hover:bg-ev-paper"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit this page on GitHub
            </a>
            <a
              href={siteConfig.github}
              className="inline-flex min-h-9 items-center gap-2 rounded-full px-4 font-round text-sm font-bold text-ev-ink-2 transition hover:bg-ev-raised hover:text-ev-ink"
            >
              <GithubMark className="h-4 w-4" />
              View the repo
            </a>
          </div>
        </div>

        <DocPager prev={prev} next={next} />
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-24 flex max-h-[calc(100vh-8rem)] flex-col gap-6 overflow-y-auto">
          <DocToc items={toc} />
          <a
            href={docEditUrl(slug)}
            className="inline-flex items-center gap-2 text-sm text-ev-ink-2 transition hover:text-ev-slate"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit this page
          </a>
        </div>
      </aside>
    </div>
  );
}
