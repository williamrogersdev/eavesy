import { absoluteUrl, siteConfig } from '@/lib/site';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema = Record<string, any>;

export function JsonLd({ schema }: { schema: Schema | Schema[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, '\\u003c') }}
    />
  );
}

export function organizationSchema(): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: siteConfig.name,
    url: siteConfig.url,
    logo: absoluteUrl('/apple-icon.png'),
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

  };
}

export function softwareApplicationSchema(): Schema {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: siteConfig.name,
    applicationCategory: 'ProductivityApplication',
    operatingSystem: 'macOS, Web',
    description: siteConfig.description,
    url: siteConfig.url,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'Clipboard text and image capture on Mac',
      'Screenshots and screen recordings',
      'Dictation and audio recording with transcripts',
      'AI-ready Markdown summaries and transcripts',
      'Files stored locally as Markdown and JSON',
      'Read-only hosted MCP server',
    ],
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
      logo: { '@type': 'ImageObject', url: absoluteUrl('/apple-icon.png') },
    },
  };
}
