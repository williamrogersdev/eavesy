import { createFileRoute } from '@tanstack/react-router';
import { serveDmgFromR2 } from '@/server/mac-dmg';

const DMG_KEY = process.env.MAC_DMG_R2_KEY ?? 'downloads/mac/eavesy-latest.dmg';

export const Route = createFileRoute('/api/downloads/mac/latest')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const response = await serveDmgFromR2(request, DMG_KEY, {
          filename: 'Eavesy.dmg',
          cacheControl: 'public, max-age=300',
        });
        return (
          response ??
          new Response(null, {
            status: 302,
            headers: { location: '/download/mac?status=coming-soon' },
          })
        );
      },
    },
  },
});
