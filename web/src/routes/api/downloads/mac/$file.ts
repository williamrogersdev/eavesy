import { createFileRoute } from '@tanstack/react-router';
import { parseVersionedDmgName } from '@/lib/mac-dmg-name';
import { serveDmgFromR2 } from '@/server/mac-dmg';

const DMG_PREFIX = 'downloads/mac/';

// Immutable, versioned DMGs (e.g. Eavesy_0.1.9_aarch64.dmg). The Homebrew cask
// pins its sha256 to one of these, so a release must never overwrite one.
export const Route = createFileRoute('/api/downloads/mac/$file')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!parseVersionedDmgName(params.file)) {
          return new Response('Not found', { status: 404 });
        }
        const response = await serveDmgFromR2(request, `${DMG_PREFIX}${params.file}`, {
          filename: params.file,
          cacheControl: 'public, max-age=31536000, immutable',
        });
        return response ?? new Response('Not found', { status: 404 });
      },
    },
  },
});
