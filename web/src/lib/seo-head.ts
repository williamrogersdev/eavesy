import { absoluteUrl, siteConfig } from './site';

export interface SeoHeadArgs {
  title: string;
  description: string;
  path?: string;
  type?: 'website' | 'article';
  noIndex?: boolean;
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
}

export interface HeadMeta {
  title?: string;
  name?: string;
  property?: string;
  content?: string;
}
export interface HeadLink {
  rel: string;
  href: string;
}

export function seoHead({
  title,
  description,
  path = '/',
  type = 'website',
  noIndex = false,
  publishedTime,
  modifiedTime,
  authors,
}: SeoHeadArgs): { meta: HeadMeta[]; links: HeadLink[] } {
  const url = absoluteUrl(path);
  const fullTitle = title.includes(siteConfig.name)
    ? title
    : `${title} · ${siteConfig.name}`;

  const meta: HeadMeta[] = [
    { title: fullTitle },
    { name: 'description', content: description },
    { property: 'og:type', content: type },
    { property: 'og:url', content: url },
    { property: 'og:title', content: fullTitle },
    { property: 'og:description', content: description },
    { property: 'og:site_name', content: siteConfig.name },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: fullTitle },
    { name: 'twitter:description', content: description },
    { name: 'twitter:creator', content: siteConfig.twitter },
  ];

  if (type === 'article') {
    if (publishedTime)
      meta.push({ property: 'article:published_time', content: publishedTime });
    if (modifiedTime)
      meta.push({ property: 'article:modified_time', content: modifiedTime });
    for (const author of authors ?? [])
      meta.push({ property: 'article:author', content: author });
  }

  if (noIndex) {
    meta.push({ name: 'robots', content: 'noindex, nofollow' });
  }

  return {
    meta,
    links: [{ rel: 'canonical', href: url }],
  };
}
