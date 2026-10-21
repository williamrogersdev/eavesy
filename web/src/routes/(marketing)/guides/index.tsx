import { createFileRoute } from "@tanstack/react-router";
import { ResourceIndex } from "@/components/marketing/resource-pages";
import { RESOURCE_FAMILIES } from "@/lib/content";
import { seoHead } from "@/lib/seo-head";
export const Route = createFileRoute("/(marketing)/guides/")({
  head: () =>
    seoHead({
      title: RESOURCE_FAMILIES.guides.title,
      description: RESOURCE_FAMILIES.guides.description,
      path: "/guides",
    }),
  component: () => <ResourceIndex family="guides" />,
});
