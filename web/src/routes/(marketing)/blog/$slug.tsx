import { createFileRoute, notFound } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { getPost } from '@/lib/content';
import {
  Breadcrumbs,
  CTASection,
  Container,
} from '@/components/marketing/page-chrome';
import { MdxContent } from '@/components/mdx/mdx-content';
import { JsonLd, articleSchema } from '@/components/seo/json-ld';
import { seoHead } from '@/lib/seo-head';
import { formatDate, readingTimeMinutes } from '@/lib/format';

export const Route = createFileRoute('/(marketing)/blog/$slug')({
  loader: ({ params }) => {
    const post = getPost(params.slug);
    if (!post) throw notFound();
    return { slug: post.slug, frontmatter: post.frontmatter };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seoHead({
          title: loaderData.frontmatter.title,
          description: loaderData.frontmatter.description,
          path: `/blog/${loaderData.slug}`,
          type: 'article',
          publishedTime: loaderData.frontmatter.date,
          authors: loaderData.frontmatter.author
            ? [loaderData.frontmatter.author]
            : undefined,
        })
      : {},
  component: BlogPostPage,
});

function BlogPostPage() {
  const { slug } = Route.useLoaderData();
  const post = getPost(slug);
  if (!post) throw notFound();

  return (
    <main className="flex flex-1 flex-col">
      <JsonLd
        schema={articleSchema({
          title: post.frontmatter.title,
          description: post.frontmatter.description,
          path: `/blog/${slug}`,
          date: post.frontmatter.date,
          author: post.frontmatter.author,
        })}
      />

      <article className="px-6 py-14">
        <Container className="max-w-3xl">
          <Breadcrumbs
            items={[
              { name: 'Home', path: '/' },
              { name: 'Blog', path: '/blog' },
              { name: post.frontmatter.title, path: `/blog/${slug}` },
            ]}
          />

          <header className="mb-10">
            {post.frontmatter.category && (
              <span className="inline-flex items-center rounded-full border border-ev-slate/40 bg-ev-slate-soft px-2.5 py-1 text-[11px] font-medium text-ev-slate">
                {post.frontmatter.category}
              </span>
            )}
            <h1 className="mt-4 text-balance text-4xl font-extrabold tracking-tight text-ev-ink">
              {post.frontmatter.title}
            </h1>
            <p className="mt-4 text-lg text-ev-ink-2">{post.frontmatter.description}</p>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-sm text-ev-ink-2">
              <time dateTime={post.frontmatter.date}>
                {formatDate(post.frontmatter.date)}
              </time>
              <span aria-hidden>·</span>
              <span>{readingTimeMinutes(post.content)} min read</span>
              {post.frontmatter.author && (
                <>
                  <span aria-hidden>·</span>
                  <span>{post.frontmatter.author}</span>
                </>
              )}
            </div>
          </header>

          <MdxContent Component={post.Component} />

          {post.frontmatter.tags && post.frontmatter.tags.length > 0 && (
            <div className="mt-12 flex flex-wrap gap-2">
              {post.frontmatter.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-ev-line bg-ev-raised px-3 py-1 text-xs text-ev-ink-2"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="mt-12 border-t border-ev-line pt-8">
            <Link
              href="/blog"
              className="inline-flex items-center gap-2 text-sm font-medium text-ev-slate transition hover:text-ev-slate-hover"
            >
              <ArrowLeft className="h-4 w-4" /> All posts
            </Link>
          </div>
        </Container>
      </article>

      <CTASection />
    </main>
  );
}
