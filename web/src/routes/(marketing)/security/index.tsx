import { createFileRoute } from '@tanstack/react-router';
import { Lock, ServerCog, ShieldCheck, Trash2 } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import {
  Breadcrumbs,
  CTASection,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/security/')({
  head: () =>
    seoHead({
      title: 'Security & privacy',
      description:
        'How Eavesy protects recordings: local source files, encrypted cloud processing, documented model-provider policies, export, and deletion controls.',
      path: '/security',
    }),
  component: SecurityPage,
});

const PILLARS = [
  {
    icon: Lock,
    title: 'Encrypted in transit and at rest',
    body: 'TLS protects data in transit. Cloudflare-managed encryption protects audio in object storage and meeting metadata in the database at rest.',
  },
  {
    icon: ShieldCheck,
    title: 'Documented model-provider policies',
    body: 'Eavesy does not train on recording content. Cloudflare Workers AI and Anthropic’s commercial API state that customer content is not used for training without an explicit opt-in; connected OpenRouter accounts follow the user’s settings.',
  },
  {
    icon: Trash2,
    title: 'Clear deletion controls',
    body: 'Delete any recording, or your whole account, from the app; cloud copies are permanently removed. Local folders remain under your control.',
  },
  {
    icon: ServerCog,
    title: 'Minimal, transparent processors',
    body: 'A short, public list of every third party that can touch user data — and analytics never see your transcript, audio, or summary content.',
  },
];

const PROCESSORS = [
  { name: 'Anthropic', role: 'AI summaries & extraction under commercial API policy' },
  { name: 'Cloudflare', role: 'Hosting, storage, database & queues' },
  { name: 'Clerk', role: 'Authentication' },
  { name: 'OpenRouter', role: 'Optional bring-your-own AI connection' },
  { name: 'Sentry (optional)', role: 'Scrubbed error reports when enabled; never recording content' },
];

function SecurityPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Security & privacy"
        title="Built so your conversations stay yours"
        description="Your meetings are some of the most sensitive data you produce. Eavesy is designed local-first and privacy-first, with clear, auditable practices."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Security', path: '/security' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container>
          <div className="grid gap-4 sm:grid-cols-2">
            {PILLARS.map((p) => {
              const Icon = p.icon;
              return (
                <div
                  key={p.title}
                  className="rounded-2xl border border-ev-line bg-ev-raised p-6"
                >
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ev-slate-soft text-ev-slate">
                    <Icon className="h-5 w-5" />
                  </span>
                  <h2 className="mt-5 font-semibold text-ev-ink">{p.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-ev-ink-2">{p.body}</p>
                </div>
              );
            })}
          </div>

          <div className="mt-14 max-w-3xl">
            <h2 className="text-xl font-extrabold tracking-tight text-ev-ink">
              Who can touch your data
            </h2>
            <p className="mt-3 text-sm text-ev-ink-2">
              We keep the list of subprocessors short and public. See the{' '}
              <Link href="/privacy" className="text-ev-slate underline underline-offset-2">
                privacy policy
              </Link>{' '}
              for the full detail.
            </p>
            <dl className="mt-6 divide-y divide-ev-line rounded-2xl border border-ev-line">
              {PROCESSORS.map((proc) => (
                <div
                  key={proc.name}
                  className="flex items-center justify-between gap-4 px-5 py-4"
                >
                  <dt className="font-medium text-ev-ink">{proc.name}</dt>
                  <dd className="text-right text-sm text-ev-ink-2">{proc.role}</dd>
                </div>
              ))}
            </dl>
          </div>
        </Container>
      </section>

      <CTASection />
    </main>
  );
}
