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
