import { absoluteUrl, siteConfig } from '@/lib/site';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

export function JsonLd({ schema }: { schema: Schema | Schema[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
    />
  );
}

export function organizationSchema(): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteConfig.name,
    url: siteConfig.url,
    logo: absoluteUrl('/icon.png'),
    description: siteConfig.shortDescription,
    sameAs: [siteConfig.github],
  };
}

export function websiteSchema(): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: siteConfig.name,
    url: siteConfig.url,
    description: siteConfig.shortDescription,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${siteConfig.url}/blog?q={search_term_string}`,
      },
      'query-input': 'required name=search_term_string',
    },
  };
}

export function softwareApplicationSchema(
  offers: { name: string; price: string }[],
): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: siteConfig.name,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'macOS, Web',
    description: siteConfig.description,
    url: siteConfig.url,
    offers: offers.map((o) => ({
      '@type': 'Offer',
      name: o.name,
      price: o.price.replace(/[^0-9.]/g, '') || '0',
      priceCurrency: 'USD',
    })),
  };
}

export function faqSchema(faqs: { q: string; a: string }[]): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };
}

export function breadcrumbSchema(items: { name: string; path: string }[]): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function articleSchema(post: {
  title: string;
  description: string;
  path: string;
  date: string;
  modified?: string;
  author?: string;
}): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.description,
    url: absoluteUrl(post.path),
    datePublished: post.date,
    dateModified: post.modified ?? post.date,
    author: { '@type': 'Organization', name: post.author ?? siteConfig.name },
    publisher: {
      '@type': 'Organization',
      name: siteConfig.name,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/icon.png') },
    },
  };
}
