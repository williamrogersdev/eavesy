import { describe, expect, test } from "bun:test";
import { isPublished } from "./publication";
import { renderSitemap } from "./sitemap";
describe("public content eligibility", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  test("drafts and scheduled or invalid publication dates cannot go public", () => {
    expect(isPublished({ draft: true, date: "2026-01-01" }, now)).toBe(false);
    expect(isPublished({ date: "2026-10-21" }, now)).toBe(false);
    expect(isPublished({ date: "not-a-date" }, now)).toBe(false);
    expect(isPublished({ date: "2026-10-19" }, now)).toBe(true);
    expect(isPublished({}, now)).toBe(true);
  });
  test("sitemap dates reflect editorial data and never fabricate current time", () => {
    const xml = renderSitemap([
      { path: "/features" },
      { path: "/guides/test", modified: "2026-10-20" },
      { path: "/invalid", modified: "unknown" },
    ]);
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
    expect(xml).toContain("<lastmod>2026-10-20T00:00:00.000Z</lastmod>");
    expect(xml).toContain("<loc>https://eavesy.com/features</loc></url>");
    expect(renderSitemap([{ path: "/a?b=1&c=2" }])).toContain("b=1&amp;c=2");
  });
});
