import { createFileRoute } from '@tanstack/react-router';
import {
  Bento,
  DownloadCTA,
  Faq,
  FeatureShowcases,
  Hero,
  HowItWorks,
  Marquee,
} from '@/components/marketing';
import { FAQS } from '@/components/marketing/content';
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
          softwareApplicationSchema(),
          faqSchema(FAQS.map((f) => ({ q: f.q, a: f.a }))),
        ]}
      />
      <Hero />
      <Marquee />
      <FeatureShowcases />
      <Bento />
      <HowItWorks />
      <Faq />
      <DownloadCTA />
    </main>
  );
}
