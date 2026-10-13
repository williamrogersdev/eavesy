import { env } from 'cloudflare:workers';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { timeD1, withRequestTiming } from '../../src/server/perf';

const DB = (env as unknown as { DB: D1Database }).DB;

describe('timeD1 against real D1', () => {
  it('times drizzle queries and batches without breaking the runtime', async () => {
    const db = drizzle(timeD1(DB));
    let rows: unknown[] = [];
    const response = await withRequestTiming(new Request('https://x.test/api/t'), async () => {
      await db.run(sql`CREATE TABLE IF NOT EXISTS perf_t (n INTEGER)`);
      await db.batch([db.run(sql`INSERT INTO perf_t VALUES (1)`), db.run(sql`INSERT INTO perf_t VALUES (2)`)]);
      rows = await db.all(sql`SELECT n FROM perf_t ORDER BY n`);
      return new Response('ok');
    });
    expect(rows).toEqual([{ n: 1 }, { n: 2 }]);
    expect(response.headers.get('Server-Timing')).toContain('3 queries, 3 sequential');
  });
});
