import { createFileRoute } from '@tanstack/react-router';
import { Mail, MessageSquare, ShieldCheck } from 'lucide-react';
import { ContactForm } from '@/components/marketing/contact-form';
import {
  Breadcrumbs,
  Container,
  PageHero,
} from '@/components/marketing/page-chrome';
import { seoHead } from '@/lib/seo-head';
import { siteConfig } from '@/lib/site';

export const Route = createFileRoute('/(marketing)/contact/')({
  head: () =>
    seoHead({
      title: 'Contact',
      description:
        'Get in touch with the Eavesy team — sales, support, press, or security. We read every message.',
      path: '/contact',
    }),
  component: ContactPage,
});

const CHANNELS = [
  { icon: Mail, label: 'General', value: siteConfig.contactEmail },
  { icon: MessageSquare, label: 'Support', value: siteConfig.supportEmail },
  { icon: ShieldCheck, label: 'Security', value: `security@eavesy.com` },
];

function ContactPage() {
  return (
    <main className="flex flex-1 flex-col">
      <PageHero
        eyebrow="Contact"
        title="Talk to us"
        description="Questions about Eavesy, your team plan, or anything else? Send a note and we’ll get back to you."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Contact', path: '/contact' },
          ]}
        />
      </PageHero>

      <section className="px-6 py-16">
        <Container className="grid gap-10 lg:grid-cols-[1.3fr_1fr]">
          <ContactForm />

          <div className="flex flex-col gap-4">
            {CHANNELS.map((channel) => {
              const Icon = channel.icon;
              return (
                <div
                  key={channel.label}
                  className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.02] p-5"
                >
                  <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-white/[0.06] text-accent">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div>
                    <div className="text-sm font-semibold text-white">
                      {channel.label}
                    </div>
                    <a
                      href={`mailto:${channel.value}`}
                      className="text-sm text-white/55 transition hover:text-white"
                    >
                      {channel.value}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </Container>
      </section>
    </main>
  );
}
