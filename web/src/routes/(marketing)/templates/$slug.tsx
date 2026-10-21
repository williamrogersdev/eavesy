import { createFileRoute, notFound } from "@tanstack/react-router";
import { ResourceArticle } from "@/components/marketing/resource-pages";
import { getResource } from "@/lib/content";
import { seoHead } from "@/lib/seo-head";
export const Route = createFileRoute("/(marketing)/templates/$slug")({
  loader: ({ params }) => {
    const entry = getResource("templates", params.slug);
    if (!entry) throw notFound();
    return { slug: entry.slug, metadata: entry.frontmatter };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seoHead({
          title: loaderData.metadata.title,
          description: loaderData.metadata.description,
          path: `/templates/${loaderData.slug}`,
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
    <ResourceArticle family="templates" slug={Route.useLoaderData().slug} />
  );
}
