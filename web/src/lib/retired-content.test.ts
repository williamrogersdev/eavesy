import { expect, test } from "bun:test";
import { FEATURE_SLUGS } from "@/content/features";
import { PUBLIC_BLOG_REDIRECTS } from "./retired-content";
test("retired article replacements resolve to supported feature destinations", () => {
  for (const destination of PUBLIC_BLOG_REDIRECTS.values()) {
    expect(destination.startsWith("/features/")).toBe(true);
    expect(FEATURE_SLUGS).toContain(destination.slice("/features/".length));
  }
  expect(PUBLIC_BLOG_REDIRECTS.get("toString")).toBeUndefined();
  expect(PUBLIC_BLOG_REDIRECTS.get("not-a-retired-article")).toBeUndefined();
});
