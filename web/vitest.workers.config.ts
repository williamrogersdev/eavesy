import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: '../workers/processing/src/index.ts',
      miniflare: {
        compatibilityDate: '2026-07-16',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        queueProducers: {
          PROCESSING_QUEUE: 'test-processing',
        },
        r2Buckets: ['AUDIO_BUCKET'],
        bindings: {
          ANTHROPIC_API_KEY: 'test-only',
          OPS_METRICS_TOKEN: 'test-metrics-token',
          TEST_MIGRATIONS: await readD1Migrations('./drizzle'),
        },
      },
    })),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/workers/**/*.test.ts'],
  },
});
