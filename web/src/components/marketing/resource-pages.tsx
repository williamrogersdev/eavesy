import { useState } from "react";
import { Link } from "@/components/ui/app-link";
import { MdxContent } from "@/components/mdx/mdx-content";
import { JsonLd, articleSchema } from "@/components/seo/json-ld";
import { Breadcrumbs, Container, PageHero, CTASection } from "./page-chrome";
import {
  getResource,
  getResources,
  RESOURCE_FAMILIES,
  type ResourceFamily,
} from "@/lib/content";

export function ResourceIndex({ family }: { family: ResourceFamily }) {
  const info = RESOURCE_FAMILIES[family];
  return (
    <main>
      <PageHero
        eyebrow="Resources"
        title={info.title}
        description={info.description}
      >
        <Breadcrumbs
          items={[
            { name: "Home", path: "/" },
            { name: info.title, path: `/${family}` },
          ]}
        />
      </PageHero>
      <Container className="py-14">
        <nav
          aria-label="Resource collections"
          className="mb-8 flex flex-wrap gap-4"
        >
          {Object.entries(RESOURCE_FAMILIES).map(([key, value]) => (
            <Link
              key={key}
              href={`/${key}`}
              aria-current={key === family ? "page" : undefined}
              className="text-ev-coat underline underline-offset-4"
            >
              {value.title}
            </Link>
          ))}
        </nav>
        <div className="grid gap-5 sm:grid-cols-2">
          {getResources(family).map((entry) => (
            <Link
              key={entry.slug}
              href={`/${family}/${entry.slug}`}
              className="rounded-2xl border border-ev-line bg-ev-raised p-6 transition hover:border-ev-line-strong"
            >
              <h2 className="font-round text-xl font-bold text-ev-ink">
                {entry.frontmatter.title}
              </h2>
              <p className="mt-3 leading-relaxed text-ev-ink-2">
                {entry.frontmatter.description}
              </p>
              <span className="mt-5 inline-block text-sm font-semibold text-ev-coat">
                Read{" "}
                {family === "examples"
                  ? "example"
                  : family === "templates"
                    ? "template"
                    : "guide"}{" "}
                →
              </span>
            </Link>
          ))}
        </div>
      </Container>
      <CTASection />
    </main>
  );
}

function DownloadResource({ path, label }: { path: string; label: string }) {
  const [status, setStatus] = useState("");
  async function copy() {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error("Download unavailable");
      await navigator.clipboard.writeText(await response.text());
      setStatus("Copied Markdown.");
    } catch {
      setStatus("Could not copy. Use the download link to save the Markdown.");
    }
  }
  return (
    <aside
      aria-label="Downloadable resource"
      className="my-8 rounded-2xl border border-ev-line bg-ev-well p-5"
    >
      <p className="font-semibold text-ev-ink">{label}</p>
      <div className="mt-3 flex flex-wrap gap-4">
        <button
          type="button"
          onClick={() => void copy()}
          className="min-h-11 rounded-full bg-ev-coat px-5 py-2 font-semibold text-ev-on-coat"
        >
          Copy Markdown
        </button>
        <a
          href={path}
          download
          className="inline-flex min-h-11 items-center text-ev-coat underline underline-offset-4"
        >
          Download Markdown
        </a>
      </div>
      <p role="status" className="mt-2 text-sm text-ev-ink-2">
        {status}
      </p>
    </aside>
  );
}

export function ResourceArticle({
  family,
  slug,
}: {
  family: ResourceFamily;
  slug: string;
}) {
  const entry = getResource(family, slug);
  if (!entry) return null; // Route loaders reject unpublished and missing entries.
  const meta = entry.frontmatter;
  return (
    <main>
      <Container className="max-w-3xl py-12">
        <Breadcrumbs
          items={[
            { name: "Home", path: "/" },
            { name: RESOURCE_FAMILIES[family].title, path: `/${family}` },
            { name: meta.title, path: `/${family}/${slug}` },
          ]}
        />
        <JsonLd
          schema={articleSchema({
            title: meta.title,
            description: meta.description,
            path: `/${family}/${slug}`,
            date: meta.date,
            modified: meta.modified,
            author: meta.author,
          })}
        />
        <article>
          <header className="mb-9">
            <p className="text-sm font-semibold text-ev-coat">
              {RESOURCE_FAMILIES[family].title}
            </p>
            <h1 className="mt-3 font-round text-4xl font-extrabold tracking-tight text-ev-ink sm:text-5xl">
              {meta.title}
            </h1>
            <p className="mt-5 text-lg leading-relaxed text-ev-ink-2">
              {meta.description}
            </p>
            <p className="mt-4 text-sm text-ev-ink-2">
              By {meta.author} · Updated{" "}
              <time dateTime={meta.modified ?? meta.date}>
                {meta.modified ?? meta.date}
              </time>
            </p>
          </header>
          {meta.download && (
            <DownloadResource
              path={meta.download}
              label={meta.downloadLabel ?? "Use this Markdown resource"}
            />
          )}
          <MdxContent Component={entry.Component} />
        </article>
        <nav
          aria-label="Related resources"
          className="mt-12 border-t border-ev-line pt-7"
        >
          <h2 className="font-round text-xl font-bold text-ev-ink">
            Continue with
          </h2>
          <ul className="mt-4 space-y-3">
            {meta.related.map((related) => (
              <li key={related.path}>
                <Link
                  href={related.path}
                  className="text-ev-coat underline underline-offset-4"
                >
                  {related.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
      <CTASection />
    </main>
  );
}
