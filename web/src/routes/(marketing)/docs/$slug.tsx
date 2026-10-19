import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { getAllDocs, getDoc } from '@/lib/content';
import { extractToc } from '@/lib/toc';
import { Breadcrumbs } from '@/components/marketing/page-chrome';
import { DocToc } from '@/components/marketing/doc-toc';
import { DocPager, type PagerLink } from '@/components/marketing/doc-pager';
import { MdxContent } from '@/components/mdx/mdx-content';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/docs/$slug')({
  loader: ({ params }) => {
    if (params.slug === 'plans-and-billing') {
      throw redirect({ to: '/docs/$slug', params: { slug: 'fair-use-limits' }, statusCode: 301 });
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

  return (
    <div className="grid gap-12 xl:grid-cols-[1fr_15rem]">
      <article className="min-w-0">
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Docs', path: '/docs' },
            { name: frontmatter.title, path: `/docs/${slug}` },
          ]}
        />
        <header className="mb-8">
          <div className="text-xs font-semibold text-ev-slate">
            {frontmatter.category}
          </div>
          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-ev-ink">
            {frontmatter.title}
          </h1>
          <p className="mt-3 text-lg leading-relaxed text-ev-ink-2">
            {frontmatter.description}
          </p>
        </header>
        <MdxContent Component={doc.Component} />
        <DocPager prev={prev} next={next} />
      </article>

      <aside className="hidden xl:block">
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto">
          <DocToc items={toc} />
        </div>
      </aside>
    </div>
  );
}
