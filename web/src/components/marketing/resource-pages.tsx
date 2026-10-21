import { useState } from "react";
import { Link } from "@/components/ui/app-link";
import { MdxContent } from "@/components/mdx/mdx-content";
import { extractToc } from "@/lib/toc";
import { readingMinutes, RESOURCE_WORKFLOWS } from "@/lib/resource-workflows";
import { RESOURCE_TEMPLATES } from "@/lib/resource-templates";
import { TemplateWorkbench } from "./template-workbench";
import { DocToc } from "./doc-toc";
import { JsonLd, articleSchema } from "@/components/seo/json-ld";
import { Breadcrumbs, Container, PageHero, CTASection } from "./page-chrome";
import {
  getResource,
  getResources,
  RESOURCE_FAMILIES,
  type ResourceFamily,
} from "@/lib/content";

function CollectionNav({ family }: { family: ResourceFamily }) {
  return (
    <nav aria-label="Resource collections" className="flex flex-wrap gap-2">
      {Object.entries(RESOURCE_FAMILIES).map(([key, value]) => (
        <Link
          key={key}
          href={`/${key}`}
          aria-current={key === family ? "page" : undefined}
          className={`inline-flex min-h-11 items-center rounded-full border px-5 font-semibold ${key === family ? "border-ev-coat bg-ev-coat-soft text-ev-coat" : "border-ev-line text-ev-ink-2 hover:border-ev-line-strong"}`}
        >
          {value.title}
        </Link>
      ))}
    </nav>
  );
}

export function ResourceIndex({ family }: { family: ResourceFamily }) {
  const info = RESOURCE_FAMILIES[family];
  const [query, setQuery] = useState("");
  const entries = getResources(family);
  const results = entries.filter((entry) =>
    `${entry.frontmatter.title} ${entry.frontmatter.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <main>
      <PageHero
        eyebrow="The Eavesy field guide"
        title={info.title}
        description={info.description}
      >
        <CollectionNav family={family} />
      </PageHero>
      <Container className="py-12 sm:py-16">
        <section aria-labelledby="workflow-paths-title">
          <p className="text-xs font-semibold uppercase tracking-widest text-ev-coat">
            Start with the outcome
          </p>
          <h2
            id="workflow-paths-title"
            className="mt-3 font-round text-3xl font-bold text-ev-ink"
          >
            One workflow, from capture to useful context.
          </h2>
          <p className="mt-3 max-w-2xl leading-relaxed text-ev-ink-2">
            Follow a practical guide, use a portable template, and check a
            worked example. Every path explains which files to share and what
            the app actually supplies.
          </p>
          <div className="mt-7 grid gap-5 lg:grid-cols-3">
            {RESOURCE_WORKFLOWS.map((workflow, index) => (
              <article
                key={workflow.title}
                className="flex flex-col rounded-3xl border border-ev-line bg-ev-raised p-6"
              >
                <span
                  aria-hidden="true"
                  className="font-round text-sm font-bold text-ev-coat"
                >
                  0{index + 1}
                </span>
                <h3 className="mt-3 font-round text-xl font-bold text-ev-ink">
                  {workflow.title}
                </h3>
                <p className="mb-6 mt-3 text-sm leading-relaxed text-ev-ink-2">
                  {workflow.description}
                </p>
                <ol className="mt-auto space-y-3 border-t border-ev-line pt-5">
                  {workflow.steps.map((step, i) => (
                    <li key={step.path} className="flex gap-3 text-sm">
                      <span className="text-ev-ink-2">{i + 1}.</span>
                      <Link
                        href={step.path}
                        className="text-ev-coat underline underline-offset-4"
                      >
                        {step.title}
                      </Link>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        </section>
        <section
          aria-labelledby="all-resources-title"
          className="mt-16 border-t border-ev-line pt-10"
        >
          <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <h2
                id="all-resources-title"
                className="font-round text-2xl font-bold text-ev-ink"
              >
                Explore all {info.title.toLowerCase()}
              </h2>
              <p className="mt-2 text-sm text-ev-ink-2">
                {results.length} of {entries.length} resources
              </p>
            </div>
            <label className="block sm:w-80">
              <span className="mb-2 block text-sm font-semibold text-ev-ink">
                Filter {info.title.toLowerCase()}
              </span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by topic…"
                className="min-h-11 w-full rounded-xl border border-ev-line-strong bg-ev-raised px-4 text-ev-ink focus-visible:outline-2 focus-visible:outline-ev-coat"
              />
            </label>
          </div>
          <div className="mt-7 grid gap-5 sm:grid-cols-2">
            {results.map((entry) => (
              <Link
                key={entry.slug}
                href={`/${family}/${entry.slug}`}
                className="group rounded-2xl border border-ev-line bg-ev-raised p-6 transition hover:border-ev-line-strong"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-ev-coat">
                  {family === "templates"
                    ? "Editable template · Markdown download"
                    : `${readingMinutes(entry.content)} min read · ${family === "examples" ? "Worked example" : "Practical guide"}`}
                </p>
                <h3 className="mt-3 font-round text-xl font-bold text-ev-ink">
                  {entry.frontmatter.title}
                </h3>
                <p className="mt-3 leading-relaxed text-ev-ink-2">
                  {entry.frontmatter.description}
                </p>
                <span className="mt-5 inline-block text-sm font-semibold text-ev-coat">
                  {family === "templates"
                    ? "Build your template"
                    : "Read the " +
                      (family === "examples" ? "example" : "guide")}{" "}
                  →
                </span>
              </Link>
            ))}
          </div>
          {results.length === 0 && (
            <div className="mt-6 rounded-2xl border border-ev-line p-6">
              <p role="status" className="text-ev-ink-2">
                No resources match “{query}”. Try audio, recording, decision, or
                Markdown.
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 min-h-11 text-ev-coat underline underline-offset-4"
              >
                Show all resources
              </button>
            </div>
          )}
        </section>
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
  const toc = extractToc(entry.content);
  const workflow = RESOURCE_WORKFLOWS.find((item) =>
    item.steps.some((step) => step.path === `/${family}/${slug}`),
  );
  return (
    <main>
      <Container className="py-12">
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
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_240px]">
          <article className="min-w-0 max-w-3xl">
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
                By {meta.author} · {readingMinutes(entry.content)} min read ·
                Updated{" "}
                <time dateTime={meta.modified ?? meta.date}>
                  {meta.modified ?? meta.date}
                </time>
              </p>
            </header>
            <details className="mb-8 rounded-2xl border border-ev-line bg-ev-raised p-5 lg:hidden">
              <summary className="cursor-pointer font-semibold text-ev-ink">
                On this page
              </summary>
              <div className="mt-4">
                <DocToc items={toc} />
              </div>
            </details>
            {family === "templates" && RESOURCE_TEMPLATES[slug] && (
              <>
                <a
                  href="#build-your-template"
                  className="mb-5 inline-flex min-h-11 items-center rounded-full bg-ev-coat px-5 font-semibold text-ev-on-coat"
                >
                  Build your template ↓
                </a>
                <p className="mb-6 text-sm text-ev-ink-2">
                  Fill in the fields below, or download the blank Markdown and
                  use it in your own editor.
                </p>
              </>
            )}
            {meta.download && (
              <DownloadResource
                path={meta.download}
                label={meta.downloadLabel ?? "Use this Markdown resource"}
              />
            )}
            {family === "templates" && (
              <TemplateWorkbench key={slug} slug={slug} />
            )}
            <MdxContent Component={entry.Component} />
          </article>
          <aside className="sticky top-28 hidden space-y-8 lg:block">
            <DocToc items={toc} />
            {family === "templates" && RESOURCE_TEMPLATES[slug] && (
              <a
                href="#build-your-template"
                className="block rounded-xl bg-ev-coat-soft p-4 font-semibold text-ev-coat"
              >
                Edit this template ↓
              </a>
            )}
            {workflow && (
              <nav
                aria-label="This workflow"
                className="rounded-2xl border border-ev-line p-5"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-ev-ink-2">
                  This workflow
                </p>
                <h2 className="mt-2 font-round font-bold text-ev-ink">
                  {workflow.title}
                </h2>
                <ol className="mt-4 space-y-4">
                  {workflow.steps.map((step) => (
                    <li key={step.path}>
                      <Link
                        href={step.path}
                        aria-current={
                          step.path === `/${family}/${slug}`
                            ? "page"
                            : undefined
                        }
                        className="text-sm text-ev-coat underline underline-offset-4"
                      >
                        {step.title}
                      </Link>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
          </aside>
        </div>
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
