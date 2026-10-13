import { createFileRoute } from '@tanstack/react-router';
import { getObject } from '@/server/r2';

const UPDATE_PREFIX = 'downloads/mac/';

function isSafeArtifactName(file: string): boolean {
  return /^[A-Za-z0-9._-]+\.app\.tar\.gz$/.test(file) && !file.includes('..');
}

export const Route = createFileRoute('/api/downloads/mac/update/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        if (!isSafeArtifactName(params.file)) {
          return new Response('Not found', { status: 404 });
        }

        const object = await getObject(`${UPDATE_PREFIX}${params.file}`);
        if (!object) return new Response('Not found', { status: 404 });

        return new Response(object.body as unknown as BodyInit, {
          headers: {
            'content-type': 'application/gzip',
            'content-length': String(object.size),
            'content-disposition': `attachment; filename="${params.file}"`,
            'cache-control': 'public, max-age=3600',
          },
        });
      },
    },
  },
});
