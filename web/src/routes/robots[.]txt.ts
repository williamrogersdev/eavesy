import { createFileRoute } from '@tanstack/react-router';
import { absoluteUrl } from '@/lib/site';

const BODY = [
  'User-agent: *',
  'Allow: /',
  'Disallow: /app/',
  'Disallow: /api/',
  'Disallow: /sign-in',
  'Disallow: /sign-up',
  '',
  `Sitemap: ${absoluteUrl('/sitemap.xml')}`,
  `Host: ${absoluteUrl('/')}`,
  '',
].join('\n');

export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(BODY, {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'cache-control': 'public, max-age=3600',
          },
        }),
    },
  },
});
