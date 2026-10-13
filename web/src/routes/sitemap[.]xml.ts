import { createFileRoute } from '@tanstack/react-router';
import { MARKETING_ROUTES, absoluteUrl, type ChangeFreq } from '@/lib/site';
import { FEATURE_SLUGS } from '@/content/features';
import { INTEGRATION_SLUGS } from '@/content/integrations';
import { getAllPosts, getAllDocs } from '@/lib/content';

interface SitemapEntry {
  url: string;
  lastModified: Date;
  changeFrequency: ChangeFreq;
  priority: number;
}

function buildSitemap(): SitemapEntry[] {
  const now = new Date();

  const staticRoutes: SitemapEntry[] = MARKETING_ROUTES.map((r) => ({
    url: absoluteUrl(r.path),
    lastModified: now,
    changeFrequency: r.changeFrequency,
    priority: r.priority,
  }));

  const featureRoutes: SitemapEntry[] = FEATURE_SLUGS.map((slug) => ({
    url: absoluteUrl(`/features/${slug}`),
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  const integrationRoutes: SitemapEntry[] = INTEGRATION_SLUGS.map((slug) => ({
    url: absoluteUrl(`/integrations/${slug}`),
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  const docRoutes: SitemapEntry[] = getAllDocs().map((doc) => ({
    url: absoluteUrl(`/docs/${doc.slug}`),
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.6,
  }));

  const blogRoutes: SitemapEntry[] = getAllPosts().map((post) => ({
    url: absoluteUrl(`/blog/${post.slug}`),
    lastModified: new Date(post.frontmatter.date),
    changeFrequency: 'yearly',
    priority: 0.6,
  }));

  return [
    ...staticRoutes,
    ...featureRoutes,
    ...integrationRoutes,
    ...docRoutes,
    ...blogRoutes,
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function render(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (e) =>
        `  <url>\n` +
        `    <loc>${escapeXml(e.url)}</loc>\n` +
        `    <lastmod>${e.lastModified.toISOString()}</lastmod>\n` +
        `    <changefreq>${e.changeFrequency}</changefreq>\n` +
        `    <priority>${e.priority.toFixed(1)}</priority>\n` +
        `  </url>`,
    )
    .join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `${urls}\n` +
    `</urlset>\n`
  );
}

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () =>
        new Response(render(buildSitemap()), {
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            'cache-control': 'public, max-age=3600',
          },
        }),
    },
  },
});
