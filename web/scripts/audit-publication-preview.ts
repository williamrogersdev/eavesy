/** Exercise real SSR publication gates. A build/start guard rejects leftover fixtures. */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { unlinkSync } from "node:fs";
import { stat, unlink, open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertNoPublicationFixtures,
  PUBLICATION_PROBE_PREFIX,
  PUBLICATION_PROBE_COLLECTIONS,
} from "./publication-fixtures";
const request: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
const origin = process.argv[2] ?? "http://127.0.0.1:4173";
if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
  throw new Error(
    "Use a local Vite preview: this audit creates temporary source fixtures.",
  );
assertNoPublicationFixtures();
const id = `${PUBLICATION_PROBE_PREFIX}${randomUUID()}`;
const hiddenProbes = [
  ...PUBLICATION_PROBE_COLLECTIONS.map((collection) => ({
    collection,
    slug: `${id}-draft`,
    extra: "draft: true",
  })),
  { collection: "guides", slug: `${id}-scheduled`, extra: "date: 2999-01-01" },
];
const controls = PUBLICATION_PROBE_COLLECTIONS.map((collection) => ({
  collection,
  slug: `${id}-published`,
  extra: "date: 2026-01-01",
}));
const probes = [...hiddenProbes, ...controls];
const paths: string[] = [];
const cleanupErrors: string[] = [];
let clean = false;
let auditFailure: unknown;
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function cleanupOnSignal() {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isMissing(error)) console.error(`Could not remove ${path}:`, error);
    }
  }
  process.exit(130);
}
process.once("SIGINT", cleanupOnSignal);
process.once("SIGTERM", cleanupOnSignal);
try {
  for (const probe of probes) {
    const path = fileURLToPath(
      new URL(
        `../src/content/${probe.collection}/${probe.slug}.mdx`,
        import.meta.url,
      ),
    );
    // Exclusive open establishes ownership. Never register or delete an EEXIST file.
    const handle = await open(path, "wx");
    paths.push(path);
    try {
      await handle.writeFile(
        `---\ntitle: Publication test\ndescription: Temporary publication fixture\nauthor: Eavesy\ncategory: Publication QA\nrelated: []\n${probe.extra}\n---\n\nTemporary publication test.\n`,
      );
    } finally {
      await handle.close();
    }
  }
  for (const control of controls) {
    let ready = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      if (
        (await request(`${origin}/${control.collection}/${control.slug}`))
          .status === 200
      ) {
        ready = true;
        break;
      }
      await delay(250);
    }
    if (!ready)
      throw new Error(
        `Vite did not discover the ${control.collection} published control`,
      );
  }

  for (const probe of hiddenProbes) {
    const response = await request(
      `${origin}/${probe.collection}/${probe.slug}`,
      { redirect: "manual" },
    );
    if (response.status !== 404)
      throw new Error(
        `${probe.collection}/${probe.slug}: expected 404, got ${response.status}`,
      );
  }
  const xml = await (await request(`${origin}/sitemap.xml`)).text();
  for (const control of controls)
    if (!xml.includes(`/${control.collection}/${control.slug}`))
      throw new Error(
        `Published ${control.collection} control missing from sitemap`,
      );
  for (const probe of hiddenProbes)
    if (xml.includes(probe.slug))
      throw new Error(`Unpublished ${probe.collection} leaked to sitemap`);
  for (const family of PUBLICATION_PROBE_COLLECTIONS) {
    const html = await (await request(`${origin}/${family}`)).text();
    if (html.includes(`${id}-draft`) || html.includes(`${id}-scheduled`))
      throw new Error(`Unpublished content leaked to ${family} hub`);
    const control = controls.find((probe) => probe.collection === family)!;
    if (!html.includes(control.slug))
      throw new Error(`Published control missing from ${family} hub`);
  }
} catch (error) {
  auditFailure = error;
} finally {
  for (const path of paths) {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error))
        cleanupErrors.push(`Could not remove ${path}: ${String(error)}`);
    }
    try {
      await stat(path);
      cleanupErrors.push(`Fixture still exists: ${path}`);
    } catch (error) {
      if (!isMissing(error))
        cleanupErrors.push(
          `Could not verify removal of ${path}: ${String(error)}`,
        );
    }
  }
  process.removeListener("SIGINT", cleanupOnSignal);
  process.removeListener("SIGTERM", cleanupOnSignal);
  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const xml = await (await request(`${origin}/sitemap.xml`)).text();
      const statuses = await Promise.all(
        probes.map(
          async (probe) =>
            (
              await request(`${origin}/${probe.collection}/${probe.slug}`, {
                redirect: "manual",
              })
            ).status,
        ),
      );
      if (!xml.includes(id) && statuses.every((status) => status === 404)) {
        clean = true;
        break;
      }
      await delay(250);
    }
  } catch (error) {
    cleanupErrors.push(`Preview cleanup check failed: ${String(error)}`);
  }
}
if (auditFailure)
  cleanupErrors.unshift(`Publication check failed: ${String(auditFailure)}`);
if (!clean)
  cleanupErrors.push(
    "Vite still contains a removed publication fixture; restart it before continuing.",
  );
if (cleanupErrors.length) throw new Error(cleanupErrors.join("\n"));

assertNoPublicationFixtures();
console.log(
  "PASS: published control in hub/sitemap; draft and scheduled routes hidden; all temporary files removed and control now 404.",
);
