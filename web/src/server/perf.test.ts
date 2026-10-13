import { describe, expect, test } from 'bun:test';
import type { D1Database } from '@cloudflare/workers-types';
import { routeKey, timeD1, timeSpan, withRequestTiming } from './perf';

function fakeD1() {
  const batched: unknown[][] = [];
  const statement = (sql: string) => {
    const stmt = {
      sql,
      bind: () => stmt,
      all: async () => ({ results: [], meta: { duration: 2 } }),
      first: async () => null,
      raw: async () => [],
      run: async () => ({ meta: { duration: 1 } }),
    };
    return stmt;
  };
  const d1 = {
    prepare: statement,
    batch: async (stmts: unknown[]) => {
      batched.push(stmts);
      return [];
    },
  };
  return { d1: d1 as unknown as D1Database, batched, statement };
}

const request = new Request('https://eavesy.com/api/meetings/k57abcdefghijklmnop');

describe('withRequestTiming', () => {
  test('counts sequential and parallel D1 round trips', async () => {
    const { d1 } = fakeD1();
    const db = timeD1(d1);
    const response = await withRequestTiming(request, async () => {
      await timeSpan('auth', async () => {});
      await db.prepare('select 1').bind(1).all();
      await db.prepare('select 2').first();
      await Promise.all([db.prepare('a').raw(), db.prepare('b').run()]);
      return new Response('ok');
    });
    const header = response.headers.get('Server-Timing') ?? '';
    expect(header).toContain('db;dur=');
    expect(header).toContain('4 queries, 3 sequential');
    expect(header).toContain('dbsql;dur=3');
    expect(header).toContain('auth;dur=');
  });

  test('batch receives the unwrapped runtime statements', async () => {
    const { d1, batched } = fakeD1();
    const db = timeD1(d1);
    const a = db.prepare('a');
    await withRequestTiming(request, async () => {
      await db.batch([a, db.prepare('b').bind(2)]);
      return new Response('ok');
    });
    const sent = batched[0] as { sql: string }[];
    expect(sent.map((s) => s.sql)).toEqual(['a', 'b']);
    expect(sent[0]).not.toBe(a);
  });

  test('works with immutable response headers', async () => {
    const response = await withRequestTiming(request, async () => {
      const r = await fetch('data:text/plain,ok');
      return r;
    });
    expect(response.headers.get('Server-Timing')).toContain('total;dur=');
    expect(await response.text()).toBe('ok');
  });

  test('outside a request, D1 calls pass straight through', async () => {
    const { d1 } = fakeD1();
    expect(await timeD1(d1).prepare('x').all()).toEqual({ results: [], meta: { duration: 2 } });
  });
});

test('routeKey collapses ids', () => {
  expect(routeKey('/api/meetings/k57abcdefghijklmnop/brief')).toBe('/api/meetings/:id/brief');
  expect(routeKey('/api/meetings/list')).toBe('/api/meetings/list');
});
