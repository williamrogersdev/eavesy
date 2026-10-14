import type { D1Database } from '@cloudflare/workers-types';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { consumeRateLimit, type FailMode, type RateLimitResult } from '@/server/rate-limit-store';

export type { FailMode, RateLimitResult } from '@/server/rate-limit-store';

function db(): D1Database | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { DB?: D1Database }).DB ?? null;
  } catch {
    return null;
  }
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-real-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DAY_SEC = 24 * 60 * 60;

export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSec: number;
  failMode: FailMode;
}): Promise<RateLimitResult> {
  return consumeRateLimit(db(), opts);
}

/** A per-UTC-day counter: day windows start at midnight UTC. */
export async function consumeDailyBudget(opts: {
  name: string;
  limit: number;
  failMode: FailMode;
}): Promise<RateLimitResult> {
  return consumeRateLimit(db(), { key: `budget:${opts.name}`, limit: opts.limit, windowSec: DAY_SEC, failMode: opts.failMode });
}

function tooMany(error: string, retryAfterSec: number, code?: string): Response {
  return Response.json(code ? { error, code } : { error }, {
    status: 429,
    headers: { 'retry-after': String(retryAfterSec) },
  });
}

/**
 * Per-IP burst limit plus a global daily budget for routes that spend AI
 * capacity. Both fail closed: an unreachable counter must not unlock spend.
 */
export async function guardSpend(
  request: Request,
  scope: 'transcribe' | 'process',
  defaults: { perMin: number; perDay: number },
): Promise<Response | null> {
  const ip = clientIp(request);
  const perMin = intEnv(`RL_${scope.toUpperCase()}_PER_MIN`, defaults.perMin);
  const perDay = intEnv(`BUDGET_${scope.toUpperCase()}_PER_DAY`, defaults.perDay);

  const rl = await rateLimit({ key: `${scope}:${ip}`, limit: perMin, windowSec: 60, failMode: 'closed' });
  if (!rl.allowed) return tooMany('Too many requests. Please slow down and try again shortly.', rl.retryAfterSec);

  const budget = await consumeDailyBudget({ name: scope, limit: perDay, failMode: 'closed' });
  if (budget.allowed) warnAtSpendThresholds(scope, perDay - budget.remaining, perDay);
  if (!budget.allowed) {
    return tooMany('Daily free transcription capacity has been reached. Please try again tomorrow.', 3600);
  }

  return null;
}

const SPEND_WARNING_PERCENTS = [50, 80, 100] as const;

/**
 * The global budget locks every user out until midnight UTC once it runs out,
 * so log a structured line as it fills up for alerting. The counter is exact
 * and moves by one, so each threshold is crossed (and logged) once a day.
 */
function warnAtSpendThresholds(scope: string, used: number, limit: number) {
  const percent = SPEND_WARNING_PERCENTS.find((p) => used === Math.ceil((limit * p) / 100));
  if (percent === undefined) return;
  console.warn(JSON.stringify({ message: 'spend budget threshold reached', scope, percent, used, limit }));
}

/**
 * Daily per-user quotas. `failMode` is per scope: segment uploads carry a
 * user's live recording, so they stay up if the counter is unavailable; every
 * other scope spends AI capacity or produces large downloads and fails closed.
 */
export const USER_DAILY_QUOTAS = {
  segment: { limit: 600, failMode: 'open' },
  transcribe: { limit: 300, failMode: 'closed' },
  process: { limit: 100, failMode: 'closed' },
  dictation: { limit: 500, failMode: 'closed' },
  capture: { limit: 300, failMode: 'closed' },
  drop: { limit: 500, failMode: 'closed' },
  chat: { limit: 300, failMode: 'closed' },
  regenerate: { limit: 60, failMode: 'closed' },
  search: { limit: 1_000, failMode: 'closed' },
  export: { limit: 10, failMode: 'closed' },
  'meeting-export': { limit: 200, failMode: 'closed' },
} as const satisfies Record<string, { limit: number; failMode: FailMode }>;

export type QuotaScope = keyof typeof USER_DAILY_QUOTAS;

function envName(scope: string): string {
  return scope.toUpperCase().replaceAll('-', '_');
}

export async function guardUserQuota(userId: string, scope: QuotaScope): Promise<Response | null> {
  const quota = USER_DAILY_QUOTAS[scope];
  const limit = intEnv(`QUOTA_${envName(scope)}_PER_DAY`, quota.limit);
  const result = await consumeDailyBudget({ name: `user:${scope}:${userId}`, limit, failMode: quota.failMode });
  if (result.allowed) return null;
  return tooMany(
    'You’ve reached today’s limit for this. It resets at midnight UTC — contact support if you need more.',
    3600,
    'daily_quota',
  );
}

/**
 * Per-minute burst limits keyed by user (or device-pairing IP). Ingest routes
 * fail open: refusing them during a counter outage would drop recordings the
 * desktop app is already retrying. Pairing fails closed because the limit is
 * what keeps pairing codes from being guessed.
 */
export const BURST_LIMITS = {
  'session-create': { limit: 30, windowSec: 60, failMode: 'open' },
  'session-part': { limit: 120, windowSec: 60, failMode: 'open' },
  'session-finalize': { limit: 30, windowSec: 60, failMode: 'open' },
  'device-pair': { limit: 10, windowSec: 60, failMode: 'closed' },
  'device-pair-check': { limit: 30, windowSec: 60, failMode: 'closed' },
  'meeting-export': { limit: 10, windowSec: 60, failMode: 'closed' },
} as const satisfies Record<string, { limit: number; windowSec: number; failMode: FailMode }>;

export type BurstScope = keyof typeof BURST_LIMITS;

export async function guardBurst(subject: string, scope: BurstScope): Promise<Response | null> {
  const policy = BURST_LIMITS[scope];
  const limit = intEnv(`RL_${envName(scope)}_PER_WINDOW`, policy.limit);
  const result = await rateLimit({ key: `${scope}:${subject}`, limit, windowSec: policy.windowSec, failMode: policy.failMode });
  if (result.allowed) return null;
  return tooMany('Too many requests. Please slow down and try again shortly.', result.retryAfterSec, 'rate_limited');
}
