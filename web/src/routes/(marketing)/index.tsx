import { createFileRoute } from '@tanstack/react-router';
import {
  Bento,
  Comparison,
  DownloadCTA,
  Faq,
  FeatureShowcases,
  Hero,
  HowItWorks,
  Marquee,
  Pricing,
} from '@/components/marketing';
import { FAQS, PLANS } from '@/components/marketing/content';
import {
  JsonLd,
  faqSchema,
  softwareApplicationSchema,
} from '@/components/seo/json-ld';
import { seoHead } from '@/lib/seo-head';
import { siteConfig } from '@/lib/site';

export const Route = createFileRoute('/(marketing)/')({
  head: () =>
    seoHead({
      title: `${siteConfig.name} — ${siteConfig.tagline}`,
      description: siteConfig.description,
      path: '/',
    }),
  component: LandingPage,
});

function LandingPage() {
  return (
    <main className="flex flex-1 flex-col">
      <JsonLd
        schema={[
          softwareApplicationSchema(
            PLANS.filter((p) => p.price.startsWith('$')).map((p) => ({
              name: p.name,
              price: p.price,
            })),
          ),
          faqSchema(FAQS.map((f) => ({ q: f.q, a: f.a }))),
        ]}
      />
      <Hero />
      <Marquee />
      <FeatureShowcases />
      <Bento />
      <HowItWorks />
      <Comparison />
      <Pricing />
      <Faq />
      <DownloadCTA />
    </main>
  );
}
