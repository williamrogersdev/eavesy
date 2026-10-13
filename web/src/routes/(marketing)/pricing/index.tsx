import { createFileRoute } from '@tanstack/react-router';
import { Comparison, Faq, Pricing } from '@/components/marketing';
import { FAQS, PLANS } from '@/components/marketing/content';
import {
  Breadcrumbs,
  CTASection,
  PageHero,
} from '@/components/marketing/page-chrome';
import {
  JsonLd,
  faqSchema,
  softwareApplicationSchema,
} from '@/components/seo/json-ld';
import { seoHead } from '@/lib/seo-head';

export const Route = createFileRoute('/(marketing)/pricing/')({
  head: () =>
    seoHead({
      title: 'Pricing',
      description:
        'Eavesy for Mac is free to download and use. Pro and Team plans are coming soon.',
      path: '/pricing',
    }),
  component: PricingPage,
});

function PricingPage() {
  return (
    <main className="flex flex-1 flex-col">
      <JsonLd
        schema={[
          softwareApplicationSchema(
            PLANS.map((p) => ({ name: p.name, price: p.price })),
          ),
          faqSchema(FAQS.map((f) => ({ q: f.q, a: f.a }))),
        ]}
      />

      <PageHero
        eyebrow="Pricing"
        title="Start free. Upgrade when it earns its place."
        description="Eavesy for Mac is free to download and use. Pro and Team plans are coming soon."
      >
        <Breadcrumbs
          items={[
            { name: 'Home', path: '/' },
            { name: 'Pricing', path: '/pricing' },
          ]}
        />
      </PageHero>

      <Pricing showHeader={false} />
      <Comparison />
      <Faq />
      <CTASection />
    </main>
  );
}
