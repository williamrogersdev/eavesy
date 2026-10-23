import type { D1Database } from '@cloudflare/workers-types';

/**
 * Fixed-window counters in D1. One statement both admits and counts a request:
 * the upsert only increments while the window is under its limit, and SQLite
 * runs it as a single write, so concurrent requests can never over-admit the
 * way a KV read-then-write could.
 *
 * No other imports: the MCP Worker uses this module directly with its own DB
 * binding.
 */

/**
 * What to do when the counter itself can't be reached. `closed` refuses the
 * request (spend, abuse, and brute-force guards); `open` lets it through
 * (ingest paths, where dropping a user's audio costs more than a burst).
 */
export type FailMode = 'open' | 'closed';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimitPolicy {
  key: string;
  limit: number;
  windowSec: number;
  failMode: FailMode;
}

export async function consumeRateLimit(
  db: D1Database | null | undefined,
  policy: RateLimitPolicy,
  now = Date.now(),
): Promise<RateLimitResult> {
  const windowMs = policy.windowSec * 1000;
  const windowId = Math.floor(now / windowMs);
  const windowEnd = (windowId + 1) * windowMs;
  const retryAfterSec = Math.max(1, Math.ceil((windowEnd - now) / 1000));
  const unavailable = (error?: unknown): RateLimitResult => {
    console.error(
      JSON.stringify({
        message: 'rate limit store unavailable',
        key: policy.key.split(':')[0],
        failMode: policy.failMode,
        error: error instanceof Error ? error.message : error === undefined ? 'no DB binding' : 'unknown error',
      }),
    );
    return policy.failMode === 'open'
      ? { allowed: true, remaining: policy.limit, retryAfterSec: 0 }
      : { allowed: false, remaining: 0, retryAfterSec };
  };
  if (!db) return unavailable();

  try {
    const row = await db
      .prepare(
        `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ?
         RETURNING count`,
      )
      .bind(`${policy.key}:${windowId}`, windowEnd, policy.limit)
      .first<{ count: number }>();
    if (!row || row.count > policy.limit) return { allowed: false, remaining: 0, retryAfterSec };
    return { allowed: true, remaining: policy.limit - row.count, retryAfterSec: 0 };
  } catch (error) {
    return unavailable(error);
  }
}

const DAY_SEC = 24 * 60 * 60;

/**
 * Daily per-user quotas. `failMode` is per scope: segment uploads carry a
 * user's live recording, so they stay up if the counter is unavailable; every
 * other scope spends AI capacity or produces large downloads and fails closed.
 * The web app and the MCP Worker count against the same rows, so a scope's
 * limit holds however the user reaches it.
 */
export const USER_DAILY_QUOTAS = {
  // One-minute segments, two tracks: 2,400 is 20 hours of recording a day.
  segment: { limit: 2_400, failMode: 'open' },
  transcribe: { limit: 300, failMode: 'closed' },
  process: { limit: 100, failMode: 'closed' },
  dictation: { limit: 500, failMode: 'closed' },
  capture: { limit: 300, failMode: 'closed' },
  // Mac screenshots synced to the user's other Macs: storage only, no AI.
  'capture-sync': { limit: 2_000, failMode: 'closed' },
  drop: { limit: 500, failMode: 'closed' },
  chat: { limit: 300, failMode: 'closed' },
  regenerate: { limit: 60, failMode: 'closed' },
  translate: { limit: 600, failMode: 'closed' },
  'library-reindex': { limit: 20, failMode: 'closed' },
  search: { limit: 1_000, failMode: 'closed' },
  export: { limit: 10, failMode: 'closed' },
  'meeting-export': { limit: 200, failMode: 'closed' },
} as const satisfies Record<string, { limit: number; failMode: FailMode }>;

export type QuotaScope = keyof typeof USER_DAILY_QUOTAS;

/**
 * The per-UTC-day policy for one user's quota scope. `vars` is the Worker's
 * environment: `QUOTA_<SCOPE>_PER_DAY` (say `QUOTA_CAPTURE_SYNC_PER_DAY`)
 * overrides the limit, read the same way by every Worker that charges it.
 */
export function userQuotaPolicy(scope: QuotaScope, userId: string, vars: Record<string, unknown> = {}): RateLimitPolicy {
  const override = Number(vars[`QUOTA_${scope.toUpperCase().replaceAll('-', '_')}_PER_DAY`]);
  const limit = Number.isFinite(override) && override > 0 ? override : USER_DAILY_QUOTAS[scope].limit;
  return { key: `budget:user:${scope}:${userId}`, limit, windowSec: DAY_SEC, failMode: USER_DAILY_QUOTAS[scope].failMode };
}

/**
 * Gives back one use counted by `consumeRateLimit` for a request that ended up
 * doing nothing (an interrupted upload, a duplicate, a failed model call).
 * Best effort: a refund that can't be written leaves the user one use short
 * until the window ends. The window is the refund's own, so a request that
 * spans the end of a window refunds the new one; that is one use either way.
 */
export async function refundRateLimit(
  db: D1Database | null | undefined,
  policy: Pick<RateLimitPolicy, 'key' | 'windowSec'>,
  now = Date.now(),
): Promise<void> {
  if (!db) return;
  const windowId = Math.floor(now / (policy.windowSec * 1000));
  try {
    await db.prepare('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0')
      .bind(`${policy.key}:${windowId}`).run();
  } catch (error) {
    console.warn(JSON.stringify({ message: 'rate limit refund failed', key: policy.key.split(':')[0], error: error instanceof Error ? error.message : 'unknown error' }));
  }
}

const PRUNE_BATCH = 10_000;
const PRUNE_MAX_PASSES = 100;

/**
 * Drops expired windows in batches until a pass comes up short; called from
 * the hourly cron. The pass cap bounds one run; anything left waits an hour.
 */
export async function pruneRateLimits(db: D1Database, now = Date.now(), batch = PRUNE_BATCH): Promise<void> {
  for (let pass = 0; pass < PRUNE_MAX_PASSES; pass++) {
    const result = await db
      .prepare(
        `DELETE FROM rate_limits
          WHERE key IN (SELECT key FROM rate_limits WHERE expires_at < ? LIMIT ?)`,
      )
      .bind(now, batch)
      .run();
    if (result.meta.changes < batch) return;
  }
}
