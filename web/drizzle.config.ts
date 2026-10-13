import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  driver: 'd1-http', // we apply via wrangler, but keep d1-http to enable studio later
} satisfies Config;
