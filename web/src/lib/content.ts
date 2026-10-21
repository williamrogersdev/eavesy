import type { ComponentType } from "react";
import { isPublished } from "./publication";

export interface PostFrontmatter {
  title: string;
  description: string;
  date: string;
  author?: string;
  category?: string;
  tags?: string[];
  featured?: boolean;
  draft?: boolean;
  modified?: string;
}

export interface DocFrontmatter {
  title: string;
  description: string;
  category: string;
  order?: number;
  draft?: boolean;
  modified?: string;
}

export interface ChangelogFrontmatter {
  title: string;
  description?: string;
  date: string;
  version?: string;
}

type MdxComponent = ComponentType<{ components?: Record<string, unknown> }>;

interface CompiledMdx {
  default: MdxComponent;
  frontmatter?: Record<string, unknown>;
}

export interface Entry<T> {
  slug: string;
  frontmatter: T;
  content: string;
  Component: MdxComponent;
}

const COMPILED = import.meta.glob<CompiledMdx>("/src/content/**/*.mdx", {
  eager: true,
});

const RAW = import.meta.glob<string>("/src/content/**/*.mdx", {
  query: "?raw",
  import: "default",
  eager: true,
});

function slugFromPath(filePath: string): string {
  return filePath.replace(/^.*\/([^/]+)\.mdx$/, "$1");
}

function rawBody(filePath: string): string {
  const raw = RAW[filePath];
  if (typeof raw !== "string") return "";
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function toEntry<T>(filePath: string, compiled: CompiledMdx): Entry<T> {
  return {
    slug: slugFromPath(filePath),
    frontmatter: (compiled.frontmatter ?? {}) as T,
    content: rawBody(filePath),
    Component: compiled.default,
  };
}

function readCollection<T>(name: string): Entry<T>[] {
  const prefix = `/src/content/${name}/`;
  const entries: Entry<T>[] = [];
  for (const filePath of Object.keys(COMPILED)) {
    if (!filePath.startsWith(prefix)) continue;
    entries.push(toEntry<T>(filePath, COMPILED[filePath]));
  }
  return entries;
}

function loadEntry<T>(name: string, slug: string): Entry<T> | null {
  const filePath = `/src/content/${name}/${slug}.mdx`;
  const compiled = COMPILED[filePath];
  if (!compiled) return null;
  return toEntry<T>(filePath, compiled);
}

export function getAllPosts(): Entry<PostFrontmatter>[] {
  return readCollection<PostFrontmatter>("blog")
    .filter((p) => isPublished(p.frontmatter))
    .sort(
      (a, b) => +new Date(b.frontmatter.date) - +new Date(a.frontmatter.date),
    );
}

export function getPost(slug: string): Entry<PostFrontmatter> | null {
  const post = loadEntry<PostFrontmatter>("blog", slug);
  return post && isPublished(post.frontmatter) ? post : null;
}

export function getAllDocs(): Entry<DocFrontmatter>[] {
  return readCollection<DocFrontmatter>("docs")
    .filter((doc) => isPublished(doc.frontmatter))
    .sort(
      (a, b) =>
        (a.frontmatter.order ?? 99) - (b.frontmatter.order ?? 99) ||
        a.frontmatter.title.localeCompare(b.frontmatter.title),
    );
}

export function getDoc(slug: string): Entry<DocFrontmatter> | null {
  const doc = loadEntry<DocFrontmatter>("docs", slug);
  return doc && isPublished(doc.frontmatter) ? doc : null;
}

export function getDocsByCategory(): {
  category: string;
  docs: Entry<DocFrontmatter>[];
}[] {
  const groups: Record<string, Entry<DocFrontmatter>[]> = {};
  for (const doc of getAllDocs()) {
    (groups[doc.frontmatter.category] ??= []).push(doc);
  }
  return Object.entries(groups).map(([category, docs]) => ({ category, docs }));
}

export function getAllChangelog(): Entry<ChangelogFrontmatter>[] {
  return readCollection<ChangelogFrontmatter>("changelog").sort(
    (a, b) => +new Date(b.frontmatter.date) - +new Date(a.frontmatter.date),
  );
}

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
export interface ResourceFrontmatter {
  title: string;
  description: string;
  date: string;
  modified?: string;
  author: string;
  draft?: boolean;
  related: { title: string; path: string }[];
  download?: string;
  downloadLabel?: string;
}
export function getResources(
  family: ResourceFamily,
): Entry<ResourceFrontmatter>[] {
  return readCollection<ResourceFrontmatter>(family)
    .filter((entry) => isPublished(entry.frontmatter))
    .sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title));
}
export function getResource(
  family: ResourceFamily,
  slug: string,
): Entry<ResourceFrontmatter> | null {
  const entry = loadEntry<ResourceFrontmatter>(family, slug);
  return entry && isPublished(entry.frontmatter) ? entry : null;
}

export function getSupplement(
  collection: "feature-details" | "integration-details",
  slug: string,
): Entry<ResourceFrontmatter> | null {
  const entry = loadEntry<ResourceFrontmatter>(collection, slug);
  return entry && isPublished(entry.frontmatter) ? entry : null;
}
