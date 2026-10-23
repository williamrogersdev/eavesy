import { createFileRoute } from "@tanstack/react-router";
import { ResourceIndex } from "@/components/marketing/resource-pages";
import { RESOURCE_FAMILIES } from "@/lib/resource-families";
import { seoHead } from "@/lib/seo-head";
export const Route = createFileRoute("/(marketing)/templates/")({
  head: () =>
    seoHead({
      title: RESOURCE_FAMILIES.templates.title,
      description: RESOURCE_FAMILIES.templates.description,
      path: "/templates",
    }),
  component: () => <ResourceIndex family="templates" />,
});
