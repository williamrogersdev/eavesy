import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceArticle } from "@/components/marketing/resource-pages";
import { seoHead } from "@/lib/seo-head";
export const Route = createFileRoute("/(marketing)/examples/$slug")({
  // Imported on demand: loaders stay in the entry bundle, and the content
  // module carries every compiled MDX page.
  loader: async ({ params }) => {
    const { getResource } = await import("@/lib/content");
    const entry = getResource("examples", params.slug);
    if (!entry) throw notFound();
    return { slug: entry.slug, metadata: entry.frontmatter };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seoHead({
          title: loaderData.metadata.title,
          description: loaderData.metadata.description,
          path: `/examples/${loaderData.slug}`,
          type: "article",
          publishedTime: loaderData.metadata.date,
          modifiedTime:
            loaderData.metadata.modified ?? loaderData.metadata.date,
          authors: [loaderData.metadata.author],
        })
      : {},
  component: Page,
});
function Page() {
  return (
    <ResourceArticle family="examples" slug={Route.useLoaderData().slug} />
  );
}
