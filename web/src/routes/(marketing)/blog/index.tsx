import { createFileRoute } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { getAllPosts, type Entry, type PostFrontmatter } from '@/lib/content';
import {
  Breadcrumbs,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';
import { formatDate, readingTimeMinutes } from '@/lib/format';

export const Route = createFileRoute('/(marketing)/blog/')({
  head: () =>
    seoHead({
      title: 'Blog',
      description:
        'Buyer’s guides and deep dives on speech-to-text, text-to-speech, and AI image models — plus notes on context capture for AI agents, from the team building Eavesy.',
      path: '/blog',
    }),
  component: BlogIndexPage,
});

function CategoryChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-ev-slate/40 bg-ev-slate-soft px-2.5 py-1 text-[11px] font-medium text-ev-slate">
      {label}
    </span>
  );
}

function MetaRow({ post }: { post: Entry<PostFrontmatter> }) {
  return (
    <div className="flex items-center gap-2 text-xs text-ev-ink-2">
      <time dateTime={post.frontmatter.date}>
        {formatDate(post.frontmatter.date)}
      </time>
      <span aria-hidden>·</span>
      <span>{readingTimeMinutes(post.content)} min read</span>
    </div>
  );
}

function FeaturedCard({ post }: { post: Entry<PostFrontmatter> }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group relative block overflow-hidden rounded-2xl border border-ev-line bg-ev-raised p-8 transition hover:border-ev-line-strong sm:p-10"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-ev-slate-soft blur-3xl transition-opacity duration-500 group-hover:opacity-100 sm:opacity-70"
      />
      <div className="relative flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          {post.frontmatter.category && (
            <CategoryChip label={post.frontmatter.category} />
          )}
          <MetaRow post={post} />
        </div>
        <h2 className="max-w-2xl text-balance text-2xl font-extrabold tracking-tight text-ev-ink transition group-hover:text-ev-ink sm:text-3xl">
          {post.frontmatter.title}
        </h2>
        <p className="max-w-2xl text-base leading-relaxed text-ev-ink-2">
          {post.frontmatter.description}
        </p>
        <span className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-ev-slate transition group-hover:gap-2.5 group-hover:text-ev-slate-hover">
          Read guide
          <ArrowUpRight className="h-4 w-4" />
        </span>
      </div>
    </Link>
  );
}

function PostCard({ post }: { post: Entry<PostFrontmatter> }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group flex h-full flex-col gap-3 rounded-2xl border border-ev-line bg-ev-raised p-6 transition hover:-translate-y-0.5 hover:border-ev-line-strong hover:bg-ev-well"
    >
      <div className="flex flex-wrap items-center gap-2">
        {post.frontmatter.category && (
          <CategoryChip label={post.frontmatter.category} />
        )}
      </div>
      <h3 className="text-lg font-semibold leading-snug text-ev-ink transition group-hover:text-ev-ink">
        {post.frontmatter.title}
      </h3>
      <p className="line-clamp-3 flex-1 text-sm leading-relaxed text-ev-ink-2">
        {post.frontmatter.description}
      </p>
      <MetaRow post={post} />
    </Link>
  );
}

function BlogIndexPage() {
  const posts = getAllPosts();
  const featured = posts.find((p) => p.frontmatter.featured) ?? posts[0];
  const rest = posts.filter((p) => p.slug !== featured?.slug);

  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Blog"
        title="Guides on AI voice, vision & context"
        description="Hands-on buyer’s guides to the best speech-to-text, text-to-speech, and image models — plus how we think about capturing context for AI agents. Written by the team building Eavesy."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="max-w-5xl">
          {posts.length === 0 ? (
            <p className="text-ev-ink-2">No posts yet — check back soon.</p>
          ) : (
            <div className="flex flex-col gap-10">
              {featured && <FeaturedCard post={featured} />}
              {rest.length > 0 && (
                <div className="grid gap-5 sm:grid-cols-2">
                  {rest.map((post) => (
                    <PostCard key={post.slug} post={post} />
                  ))}
                </div>
              )}
            </div>
          )}
        </Container>
      </section>
    </main>
  );
}
