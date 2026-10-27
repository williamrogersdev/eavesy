import { Link } from "@/components/ui/app-link";
import { RESOURCE_WORKFLOWS } from "@/lib/resource-workflows";
import { Container } from "./page-chrome";

export function ResourceGateway() {
  return (
    <section
      className="border-t border-ev-line py-16 sm:py-24"
      aria-labelledby="resource-gateway-title"
    >
      <Container>
        <p className="text-xs font-semibold uppercase tracking-widest text-ev-coat">
          Put your context to work
        </p>
        <h2
          id="resource-gateway-title"
          className="mt-3 max-w-2xl font-round text-3xl font-extrabold tracking-tight text-ev-ink sm:text-4xl"
        >
          A practical starting point for your next capture.
        </h2>
        <p className="mt-4 max-w-2xl leading-relaxed text-ev-ink-2">
          See what to record, how to check the source, and what to hand your
          agent. Use the guides and editable Markdown templates with your own
          evidence.
        </p>
        <div className="mt-8 grid gap-5 lg:grid-cols-3">
          {RESOURCE_WORKFLOWS.map((workflow) => (
            <article
              key={workflow.title}
              className="rounded-3xl border border-ev-line bg-ev-raised p-6"
            >
              <h3 className="font-round text-xl font-bold text-ev-ink">
                {workflow.title}
              </h3>
              <p className="mb-5 mt-3 text-sm leading-relaxed text-ev-ink-2">
                {workflow.description}
              </p>
              <ul className="space-y-3">
                {workflow.steps.map((step) => (
                  <li key={step.path}>
                    <Link
                      href={step.path}
                      className="text-sm text-ev-coat underline underline-offset-4"
                    >
                      {step.title} →
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <nav
          aria-label="Browse resources"
          className="mt-8 flex flex-wrap gap-5 text-sm font-semibold text-ev-coat"
        >
          <Link href="/guides">All guides →</Link>
          <Link href="/templates">All templates →</Link>
          <Link href="/examples">All examples →</Link>
        </nav>
      </Container>
    </section>
  );
}
