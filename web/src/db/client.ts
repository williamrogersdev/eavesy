import { getCloudflareContext } from '@/server/cloudflare-context';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';

import * as schema from './schema';

export type AppDb = DrizzleD1Database<typeof schema>;

export function getDb(): AppDb {
  const { env } = getCloudflareContext();
  const d1 = (env as unknown as { DB?: D1Database }).DB;
  if (!d1) {
    throw new Error(
      'D1 binding (DB) is missing. Did you provision the database with `bunx wrangler d1 create eavesy` and update wrangler.toml?',
    );
  }
  return drizzle(d1, { schema });
}

export type { D1Database };
export { schema };
