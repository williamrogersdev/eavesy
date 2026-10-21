import { PUBLIC_BLOG_REDIRECTS } from "../src/lib/retired-content";
import { FIRST_SEARCH_PAGES } from "../src/lib/search-launch";
/** Read-only SSR audit. Run against a local preview or an explicitly selected deployed origin. */
const request: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
const origin = process.argv[2] ?? "http://127.0.0.1:4173";
const canonicalOrigin = "https://eavesy.com";
const failures: string[] = [];
const results: { path: string; status: number; title: string }[] = [];
function check(ok: unknown, message: string) {
  if (!ok) failures.push(message);
}
const xmlResponse = await request(`${origin}/sitemap.xml`);
check(xmlResponse.ok, "Sitemap must return 200");
const xml = await xmlResponse.text();
const paths = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(
  (match) => new URL(match[1].replaceAll("&amp;", "&")).pathname,
);
check(paths.length > 60, "Expected the expanded public sitemap");
check(new Set(paths).size === paths.length, "Duplicate sitemap paths");
for (const entry of FIRST_SEARCH_PAGES)
  check(
    paths.includes(entry.path),
    `First publishing cluster missing from sitemap: ${entry.path}`,
  );
const linkPaths = new Set<string>();
for (let i = 0; i < paths.length; i += 6) {
  await Promise.all(
    paths.slice(i, i + 6).map(async (path) => {
      const response = await request(`${origin}${path}`, {
        redirect: "manual",
      });
      const html = await response.text();
      const title = html.match(/<title>(.*?)<\/title>/s)?.[1] ?? "";
      const canonicals = [
        ...html.matchAll(
          /<link\b(?=[^>]*\brel="canonical")[^>]*\bhref="([^"]+)"[^>]*>/g,
        ),
      ];
      results.push({ path, status: response.status, title });
      check(response.status === 200, `${path}: status ${response.status}`);
      check(title, `${path}: missing title`);
      check(
        (html.match(/<h1\b/g) ?? []).length === 1,
        `${path}: expected one H1`,
      );
      check(canonicals.length === 1, `${path}: expected one canonical`);
      check(
        canonicals[0]?.[1] === `${canonicalOrigin}${path === "/" ? "" : path}`,
        `${path}: wrong canonical`,
      );
      check(
        /<meta\b(?=[^>]*name="description")[^>]*content="[^"]+"/.test(html),
        `${path}: missing description`,
      );
      check(
        !/<meta\b(?=[^>]*name="robots")[^>]*content="[^"]*noindex/.test(html),
        `${path}: indexable page is noindex`,
      );
      for (const match of html.matchAll(/<a\b[^>]*href="(\/(?!\/)[^"#?]*)/g)) {
        if (
          !/^\/(?:app|sign-in|sign-up|api|connect|onboarding)(?:\/|$)/.test(
            match[1],
          )
        )
          linkPaths.add(match[1]);
      }
    }),
  );
}
const unseen = [...linkPaths].filter((path) => !paths.includes(path));
for (let i = 0; i < unseen.length; i += 6)
  await Promise.all(
    unseen.slice(i, i + 6).map(async (path) => {
      const response = await request(`${origin}${path}`, {
        redirect: "manual",
      });
      check(
        response.status === 200 ||
          response.status === 301 ||
          response.status === 302,
        `Broken internal link ${path}: ${response.status}`,
      );
    }),
  );
for (const path of [
  "/guides/not-a-real-guide",
  "/templates/not-a-real-template",
  "/examples/not-a-real-example",
  "/features/not-a-real-feature",
  "/integrations/not-a-real-tool",
  "/blog/not-a-real-post",
  "/blog/toString",
  "/blog/best-text-to-speech-ai-models",
]) {
  const response = await request(`${origin}${path}`, { redirect: "manual" });
  check(response.status === 404, `${path}: must return real 404`);
}
for (const [slug, to] of PUBLIC_BLOG_REDIRECTS.entries()) {
  const from = `/blog/${slug}`;
  const response = await request(`${origin}${from}`, { redirect: "manual" });
  check(
    response.status === 301 && response.headers.get("location") === to,
    `${from}: expected permanent redirect to ${to}`,
  );
}
const home = await (await request(origin)).text();
check(
  !home.includes("Meeting bots"),
  "Homepage still contains comparison section",
);
check(
  !home.includes("Live captions are not available yet"),
  "Homepage still denies supported captions",
);
check(
  !home.includes("SearchAction"),
  "Unsupported public SearchAction is still declared",
);
const allTitles = results.map((row) => row.title);
check(new Set(allTitles).size === allTitles.length, "Duplicate page titles");
console.log(
  JSON.stringify(
    {
      origin,
      sitemapPages: paths.length,
      additionalInternalLinks: unseen.length,
      failures,
      results: results.sort((a, b) => a.path.localeCompare(b.path)),
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
