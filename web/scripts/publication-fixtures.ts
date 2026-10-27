import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const PUBLICATION_PROBE_PREFIX = "audit-publication-";
export const PUBLICATION_PROBE_COLLECTIONS = [
  "guides",
  "templates",
  "examples",
  "blog",
  "docs",
] as const;
export function assertNoPublicationFixtures(): void {
  const stale = PUBLICATION_PROBE_COLLECTIONS.flatMap((collection) => {
    const directory = new URL(`../src/content/${collection}/`, import.meta.url);
    return readdirSync(directory)
      .filter((file) => file.startsWith(PUBLICATION_PROBE_PREFIX))
      .map((file) => fileURLToPath(new URL(file, directory)));
  });
  if (stale.length)
    throw new Error(
      `Stale publication audit fixtures must be removed before starting Vite or building:\n${stale.join("\n")}`,
    );
}
