import { getCloudflareContext } from '@/server/cloudflare-context';
import type { KVNamespace } from '@cloudflare/workers-types';

function kv(): KVNamespace | null {
  try {
    const { env } = getCloudflareContext();
    return (env as unknown as { CACHE?: KVNamespace }).CACHE ?? null;
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

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitResult> {
  const store = kv();
  if (!store) return { allowed: true, remaining: opts.limit, retryAfterSec: 0 };

  const windowMs = opts.windowSec * 1000;
  const windowId = Math.floor(Date.now() / windowMs);
  const k = `rl:${opts.key}:${windowId}`;

  let current = 0;
  try {
    current = Number((await store.get(k)) ?? '0') || 0;
  } catch {
    return { allowed: true, remaining: opts.limit, retryAfterSec: 0 };
  }

  if (current >= opts.limit) {
    const nextWindowStart = (windowId + 1) * windowMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((nextWindowStart - Date.now()) / 1000)),
    };
  }

  try {
    await store.put(k, String(current + 1), { expirationTtl: opts.windowSec + 5 });
  } catch {
    /* fail open on write error */
  }
  return { allowed: true, remaining: opts.limit - current - 1, retryAfterSec: 0 };
}

export async function consumeDailyBudget(opts: {
  name: string;
  limit: number;
}): Promise<{ allowed: boolean }> {
  const store = kv();
  if (!store) return { allowed: true };

  const day = new Date().toISOString().slice(0, 10);
  const k = `budget:${opts.name}:${day}`;

  let current = 0;
  try {
    current = Number((await store.get(k)) ?? '0') || 0;
  } catch {
    return { allowed: true };
  }
  if (current >= opts.limit) return { allowed: false };

  try {
    await store.put(k, String(current + 1), { expirationTtl: 172_800 });
  } catch {
    /* fail open */
  }
  return { allowed: true };
}

export async function guardSpend(
  request: Request,
  scope: 'transcribe' | 'process',
  defaults: { perMin: number; perDay: number },
): Promise<Response | null> {
  const ip = clientIp(request);
  const perMin = intEnv(`RL_${scope.toUpperCase()}_PER_MIN`, defaults.perMin);
  const perDay = intEnv(`BUDGET_${scope.toUpperCase()}_PER_DAY`, defaults.perDay);

  const rl = await rateLimit({ key: `${scope}:${ip}`, limit: perMin, windowSec: 60 });
  if (!rl.allowed) {
    return new Response(
      JSON.stringify({ error: 'Too many requests. Please slow down and try again shortly.' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(rl.retryAfterSec),
        },
      },
    );
  }

  const budget = await consumeDailyBudget({ name: scope, limit: perDay });
  if (!budget.allowed) {
    return new Response(
      JSON.stringify({
        error: 'Daily free transcription capacity has been reached. Please try again tomorrow.',
      }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' } },
    );
  }

  return null;
}

export const USER_DAILY_QUOTAS = {
  segment: 600,
  transcribe: 300,
  process: 100,
  dictation: 500,
  capture: 300,
  drop: 500,
  chat: 300,
  regenerate: 60,
  search: 1_000,
  export: 10,
} as const;

export type QuotaScope = keyof typeof USER_DAILY_QUOTAS;

export async function guardUserQuota(userId: string, scope: QuotaScope): Promise<Response | null> {
  const limit = intEnv(`QUOTA_${scope.toUpperCase()}_PER_DAY`, USER_DAILY_QUOTAS[scope]);
  const result = await consumeDailyBudget({ name: `user:${scope}:${userId}`, limit });
  if (result.allowed) return null;
  return new Response(
    JSON.stringify({
      error: 'You’ve reached today’s limit for this. It resets at midnight UTC — contact support if you need more.',
      code: 'daily_quota',
    }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3600' } },
  );
}
