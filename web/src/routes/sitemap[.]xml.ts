import { createFileRoute } from "@tanstack/react-router";
import { MARKETING_ROUTES } from "@/lib/site";
import { FEATURE_SLUGS } from "@/content/features";
import { INTEGRATION_SLUGS } from "@/content/integrations";
import {
  getAllPosts,
  getAllDocs,
  getResources,
  RESOURCE_FAMILIES,
  type ResourceFamily,
} from "@/lib/content";
import { renderSitemap, type SitemapEntry } from "@/lib/sitemap";
function entries(): SitemapEntry[] {
  return [
    ...MARKETING_ROUTES.map(({ path }) => ({ path })),
    ...FEATURE_SLUGS.map((slug) => ({ path: `/features/${slug}` })),
    ...INTEGRATION_SLUGS.map((slug) => ({ path: `/integrations/${slug}` })),
    ...getAllDocs().map((doc) => ({
      path: `/docs/${doc.slug}`,
      modified: doc.frontmatter.modified,
    })),
    ...getAllPosts().map((post) => ({
      path: `/blog/${post.slug}`,
      modified: post.frontmatter.modified ?? post.frontmatter.date,
    })),
    ...(Object.keys(RESOURCE_FAMILIES) as ResourceFamily[]).flatMap((family) =>
      getResources(family).map((entry) => ({
        path: `/${family}/${entry.slug}`,
        modified: entry.frontmatter.modified ?? entry.frontmatter.date,
      })),
    ),
  ];
}
export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () =>
        new Response(renderSitemap(entries()), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
});
