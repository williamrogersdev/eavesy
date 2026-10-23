import { createFileRoute } from "@tanstack/react-router";
import { ResourceIndex } from "@/components/marketing/resource-pages";
import { RESOURCE_FAMILIES } from "@/lib/resource-families";
import { seoHead } from "@/lib/seo-head";
export const Route = createFileRoute("/(marketing)/examples/")({
  head: () =>
    seoHead({
      title: RESOURCE_FAMILIES.examples.title,
      description: RESOURCE_FAMILIES.examples.description,
      path: "/examples",
    }),
  component: () => <ResourceIndex family="examples" />,
});
