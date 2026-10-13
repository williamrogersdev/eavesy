# web/ — TanStack Start on Cloudflare Workers

This app runs on **TanStack Start** (Vite + `@cloudflare/vite-plugin`), deployed
natively to Cloudflare Workers. It is **not** Next.js — there is no `src/app`,
no `next/*`, no OpenNext. If your training data assumes Next.js conventions,
ignore them here.

## Conventions

- **Routes** live in `src/routes/**` (file-based). Dynamic segments are `$id`,
  catch-all is `$` (`params._splat`), pathless groups are `(group)`, and a
  pathless layout is a `route.tsx` rendering `<Outlet/>`.
- **Pages**: `createFileRoute('/path')({ head, loader?, component })`. Per-page
  SEO via `head: () => seoHead({...})` (`@/lib/seo-head`).
- **API / server routes**: `createFileRoute('/api/x')({ server: { handlers: {
  GET, POST } } })`, handlers receive `{ request, params }` and return a
  web-standard `Response` (`Response.json(...)`).
- **Cloudflare bindings**: access via `getCloudflareContext().env` from
  `@/server/cloudflare-context` (D1, R2, KV, Queues, Vectorize, AI). `getDb()`,
  `bucket()`, etc. already wrap this.
- **Auth**: `@clerk/tanstack-react-start`; server middleware in `src/start.ts`;
  the `/app` gate is a `beforeLoad` + server function in `src/routes/app/route.tsx`.
- **Navigation/links** in client code: `@/components/ui/app-link` (`<Link href>`)
  and `@/lib/next-compat/navigation` (`useRouter`/`usePathname`/`useParams`/
  `redirect`). These are thin compat shims over TanStack Router.
- **MDX** content (`src/content/**`) is bundled at build time via
  `import.meta.glob`; frontmatter is exported by `remark-mdx-frontmatter`. Read
  it through `@/lib/content`.
- **Worker entry** is `src/worker.ts`, a thin pass-through to the authenticated
  TanStack Start handler. Long-form desktop ingest uses `/api/sessions/*`.

## Before writing code

Verify framework APIs against the installed packages / current docs (TanStack
Router/Start move fast). Run `bunx tsc --noEmit` and `bun run build` — both must
stay green.
