// Kept apart from `@/lib/content` so route `head`s can read these names
// without pulling every compiled MDX page into the entry bundle.
export const RESOURCE_FAMILIES = {
  guides: {
    title: "Guides",
    description:
      "Practical ways to capture, organize, and hand context to your AI with Eavesy.",
  },
  templates: {
    title: "Templates",
    description:
      "Copyable Markdown templates for bug reports, decisions, and meeting action items.",
  },
  examples: {
    title: "Examples",
    description:
      "Worked examples with downloadable source material and clear steps you can follow.",
  },
} as const;
export type ResourceFamily = keyof typeof RESOURCE_FAMILIES;
