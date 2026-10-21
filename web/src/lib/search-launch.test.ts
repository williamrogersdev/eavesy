import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { FIRST_SEARCH_PAGES } from "./search-launch";

test("every first-cluster page has real authored content and correct supplement routing", () => {
  expect(FIRST_SEARCH_PAGES).toHaveLength(20);
  expect(new Set(FIRST_SEARCH_PAGES.map((page) => page.path)).size).toBe(20);
  for (const page of FIRST_SEARCH_PAGES) {
    const content = readFileSync(
      new URL(`../content/${page.content}`, import.meta.url),
      "utf8",
    );
    expect(content).toContain("title:");
    expect(content).toContain("description:");
    expect(content.split("---")[2]?.trim()).toBeTruthy();
    if (page.path.startsWith("/features/")) {
      const catalog = readFileSync(
        new URL("../content/features.ts", import.meta.url),
        "utf8",
      );
      expect(catalog).toContain(`slug: '${page.path.split("/")[2]}'`);
    }
    if (page.path.startsWith("/integrations/")) {
      const catalog = readFileSync(
        new URL("../content/integrations.ts", import.meta.url),
        "utf8",
      );
      expect(catalog).toContain(`slug: '${page.path.split("/")[2]}'`);
    }
  }
});
