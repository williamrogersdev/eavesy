import { createFileRoute } from '@tanstack/react-router';
import type { D1Database } from '@cloudflare/workers-types';
import { getCloudflareContext } from '@/server/cloudflare-context';

interface MetricsEnv {
  DB?: D1Database;
  OPS_METRICS_TOKEN?: string;
}

export const Route = createFileRoute('/api/ops/metrics')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { env } = getCloudflareContext();
        const runtime = env as unknown as MetricsEnv;
        if (!runtime.DB || !runtime.OPS_METRICS_TOKEN) {
          return Response.json({ error: 'metrics_not_configured' }, { status: 503 });
        }
        const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (!(await equalSecret(bearer, runtime.OPS_METRICS_TOKEN))) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
        const requestedDays = Number(new URL(request.url).searchParams.get('days') ?? '30');
        const days = Math.min(
          90,
          Math.max(1, Math.floor(Number.isFinite(requestedDays) ? requestedDays : 30)),
        );
        const rows = await runtime.DB.prepare(
          `SELECT date, signups, onboarded_users, paired_devices,
                  users_first_recording, users_first_transcript,
                  users_first_brief_use, users_first_return_7d,
                  meetings_started, meetings_completed,
                  meetings_brief_used, meetings_failed,
                  meetings_stuck, processing_samples, processing_ms_total,
                  processing_ms_max,
                  CASE WHEN processing_samples > 0
                    THEN processing_ms_total / processing_samples
                    ELSE 0 END AS average_processing_ms,
                  first_transcript_samples, first_transcript_ms_max,
                  CASE WHEN first_transcript_samples > 0
                    THEN first_transcript_ms_total / first_transcript_samples
                    ELSE 0 END AS average_first_transcript_ms,
                  audio_seconds,
                  estimated_ai_cost_microusd AS estimated_platform_ai_cost_microusd,
                  updated_at
             FROM product_metrics_daily
            ORDER BY date DESC
            LIMIT ?`,
        )
          .bind(days)
          .all();
        return Response.json(
          {
            rows: rows.results,
            pricingAssumptions: {
              asOf: '2026-07-17',
              whisperUsdPerMinute: 0.00051,
              sonnet46UsdPerMillionInputTokens: 3,
              sonnet46UsdPerMillionOutputTokens: 15,
              tokenEstimate: '4 characters per token',
            },
          },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      },
    },
  },
});

async function equalSecret(actual: string, expected: string): Promise<boolean> {
  if (!actual || actual.length !== expected.length) return false;
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(actual)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected)),
  ]);
  const left = new Uint8Array(actualHash);
  const right = new Uint8Array(expectedHash);
  let different = 0;
  for (let index = 0; index < left.length; index += 1) different |= left[index] ^ right[index];
  return different === 0;
}
