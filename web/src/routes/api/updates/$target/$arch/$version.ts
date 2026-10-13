import { createFileRoute } from '@tanstack/react-router';
import { compareVersions } from '@/lib/version';
import { getObject } from '@/server/r2';

const MANIFEST_KEY = process.env.MAC_UPDATE_MANIFEST_R2_KEY ?? 'downloads/mac/latest.json';

interface UpdateManifest {
  version: string;
  pub_date?: string;
  notes?: string;
  platforms: Record<string, { url: string; signature: string }>;
}

export const Route = createFileRoute('/api/updates/$target/$arch/$version')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const object = await getObject(MANIFEST_KEY);
        if (!object) return new Response(null, { status: 204 });

        let manifest: UpdateManifest;
        try {
          manifest = JSON.parse(await object.text()) as UpdateManifest;
        } catch {
          console.error('[updates] manifest is not valid JSON');
          return new Response(null, { status: 204 });
        }

        const platform = manifest.platforms?.[`${params.target}-${params.arch}`];
        if (!platform || !manifest.version) return new Response(null, { status: 204 });

        if (compareVersions(manifest.version, params.version) <= 0) {
          return new Response(null, { status: 204 });
        }

        return Response.json({
          version: manifest.version,
          pub_date: manifest.pub_date,
          notes: manifest.notes,
          url: platform.url,
          signature: platform.signature,
        });
      },
    },
  },
});
