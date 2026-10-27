import { getSupplement } from "@/lib/content";
import { MdxContent } from "@/components/mdx/mdx-content";
import { Link } from "@/components/ui/app-link";
import { Container } from "./page-chrome";
export function ContentSupplement({
  collection,
  slug,
}: {
  collection: "feature-details" | "integration-details";
  slug: string;
}) {
  const entry = getSupplement(collection, slug);
  if (!entry) return null;
  return (
    <section className="border-t border-ev-line py-12">
      <Container className="max-w-3xl">
        <MdxContent Component={entry.Component} />
        <nav
          aria-label="Workflow resources"
          className="mt-8 border-t border-ev-line pt-6"
        >
          <h2 className="font-round text-xl font-bold text-ev-ink">
            Try the workflow
          </h2>
          <ul className="mt-3 space-y-3">
            {entry.frontmatter.related.map((link) => (
              <li key={link.path}>
                <Link
                  href={link.path}
                  className="text-ev-coat underline underline-offset-4"
                >
                  {link.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>
    </section>
  );
}
