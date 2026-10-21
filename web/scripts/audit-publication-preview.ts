/** Exercise publication gates through the actual SSR loaders; local preview only. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
const origin = process.argv[2] ?? "http://127.0.0.1:4173";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error(
    "Use a local Vite preview: this audit creates temporary source fixtures.",
  );
const id = randomUUID();
const probes = [
  ...["guides", "templates", "examples", "blog", "docs"].map((collection) => ({
    collection,
    slug: `draft-${id}`,
    extra: "draft: true",
  })),
  { collection: "guides", slug: `scheduled-${id}`, extra: "date: 2999-01-01" },
  { collection: "guides", slug: `published-${id}`, extra: "date: 2026-01-01" },
];
const paths: string[] = [];
try {
  for (const probe of probes) {
    const path = fileURLToPath(
      new URL(
        `../src/content/${probe.collection}/${probe.slug}.mdx`,
        import.meta.url,
      ),
    );
    paths.push(path);
    await writeFile(
      path,
      `---\ntitle: Publication test\ndescription: Temporary publication fixture\nauthor: Eavesy\nrelated: []\n${probe.extra}\n---\n\nTemporary publication test.\n`,
    );
  }
  const control = probes[probes.length - 1];
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    if (
      (await fetch(`${origin}/${control.collection}/${control.slug}`))
        .status === 200
    ) {
      ready = true;
      break;
    }
    await delay(250);
  }
  if (!ready)
    throw new Error("Vite did not discover the published control fixture");
  for (const probe of probes.slice(0, -1)) {
    const response = await fetch(
      `${origin}/${probe.collection}/${probe.slug}`,
      { redirect: "manual" },
    );
    if (response.status !== 404)
      throw new Error(
        `${probe.collection}/${probe.slug}: expected 404, got ${response.status}`,
      );
  }
  const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
  for (const probe of probes.slice(0, -1))
    if (xml.includes(probe.slug))
      throw new Error(`Unpublished ${probe.collection} leaked to sitemap`);
  for (const family of ["guides", "templates", "examples", "blog", "docs"]) {
    const html = await (await fetch(`${origin}/${family}`)).text();
    if (html.includes(`draft-${id}`) || html.includes(`scheduled-${id}`))
      throw new Error(`Unpublished content leaked to ${family} hub`);
  }
  console.log(
    "PASS: published control returns 200; five draft routes and a scheduled guide return 404 and are absent from sitemap and hubs.",
  );
} finally {
  for (const path of paths) await unlink(path).catch(() => {});
  // Wait for Vite to invalidate eager content globs before another audit/build.
  let clean = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const xml = await (await fetch(`${origin}/sitemap.xml`)).text();
    if (!xml.includes(id)) { clean = true; break; }
    await delay(250);
  }
  if (!clean) throw new Error('Preview still contains a removed publication fixture; restart it before auditing or building.');

}
