export const siteConfig = {
  name: 'Eavesy',
  tagline: 'Turn real work into AI-ready context.',
  url: 'https://eavesy.com',
  description:
    'Record a workflow, meeting, or bug reproduction. Eavesy turns screen and voice into a structured Markdown brief, transcript, and files you control—ready for Claude, Cursor, ChatGPT, or any AI agent.',
  shortDescription:
    'Capture screen and voice, then hand any AI agent a structured brief it can act on.',
  twitter: '@eavesy',
  github: 'https://github.com/williamrogersdev/eavesy',
  contactEmail: 'hello@eavesy.com',
  supportEmail: 'support@eavesy.com',
} as const;

export type ChangeFreq =
  | 'always'
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'yearly'
  | 'never';

export interface RouteEntry {
  path: string;
  changeFrequency: ChangeFreq;
  priority: number;
}

export const MARKETING_ROUTES: RouteEntry[] = [
  { path: '/', changeFrequency: 'weekly', priority: 1 },
  { path: '/features', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/how-it-works', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/pricing', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/integrations', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/docs', changeFrequency: 'weekly', priority: 0.7 },
  { path: '/blog', changeFrequency: 'daily', priority: 0.7 },
  { path: '/changelog', changeFrequency: 'weekly', priority: 0.6 },
  { path: '/about', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/contact', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/security', changeFrequency: 'monthly', priority: 0.5 },
  { path: '/download/mac', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
];

export function absoluteUrl(path = '/'): string {
  if (path === '/') return siteConfig.url;
  return `${siteConfig.url}${path.startsWith('/') ? path : `/${path}`}`;
}
