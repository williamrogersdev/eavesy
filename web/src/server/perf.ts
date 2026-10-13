import { AsyncLocalStorage } from 'node:async_hooks';
import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

interface RequestTiming {
  dbCount: number;
  dbMs: number;
  dbSqlMs: number;
  dbSequential: number;
  dbInFlight: number;
  spans: Map<string, number>;
}

const storage = new AsyncLocalStorage<RequestTiming>();

export async function timeSpan<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const timing = storage.getStore();
  if (!timing) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timing.spans.set(name, (timing.spans.get(name) ?? 0) + performance.now() - start);
  }
}

async function timeDbCall<T>(fn: () => Promise<T>): Promise<T> {
  const timing = storage.getStore();
  if (!timing) return fn();
  timing.dbCount += 1;
  if (timing.dbInFlight === 0) timing.dbSequential += 1;
  timing.dbInFlight += 1;
  const start = performance.now();
  try {
    const result = await fn();
    const duration = (result as { meta?: { duration?: number } } | null)?.meta?.duration;
    if (typeof duration === 'number') timing.dbSqlMs += duration;
    return result;
  } finally {
    timing.dbInFlight -= 1;
    timing.dbMs += performance.now() - start;
  }
}

const RAW = Symbol('d1.raw');
const EXECUTORS = new Set(['all', 'run', 'first', 'raw']);

function timeStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, key) {
      if (key === RAW) return target;
      if (key === 'bind') {
        return (...args: unknown[]) => timeStatement(target.bind(...args));
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      const method = value as (...a: unknown[]) => unknown;
      if (typeof key === 'string' && EXECUTORS.has(key)) {
        return (...args: unknown[]) => timeDbCall(() => method.apply(target, args) as Promise<unknown>);
      }
      return method.bind(target);
    },
  });
}

const timedBindings = new WeakMap<D1Database, D1Database>();

export function timeD1(d1: D1Database): D1Database {
  const cached = timedBindings.get(d1);
  if (cached) return cached;
  const timed = new Proxy(d1, {
    get(target, key) {
      if (key === 'prepare') {
        return (query: string) => timeStatement(target.prepare(query));
      }
      if (key === 'batch') {
        return (statements: D1PreparedStatement[]) =>
          timeDbCall(() =>
            target.batch(
              statements.map(
                (s) => ((s as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? s),
              ),
            ),
          );
      }
      if (key === 'exec') {
        return (query: string) => timeDbCall(() => target.exec(query));
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  timedBindings.set(d1, timed);
  return timed;
}

export function routeKey(pathname: string): string {
  return pathname
    .split('/')
    .map((part) => (/^[0-9a-z_-]{16,}$/i.test(part) || /^\d+$/.test(part) ? ':id' : part))
    .join('/');
}

const round = (ms: number) => Math.round(ms * 10) / 10;

export async function withRequestTiming(
  request: Request,
  handle: () => Promise<Response>,
): Promise<Response> {
  const timing: RequestTiming = {
    dbCount: 0,
    dbMs: 0,
    dbSqlMs: 0,
    dbSequential: 0,
    dbInFlight: 0,
    spans: new Map(),
  };
  const start = performance.now();
  const response = await storage.run(timing, handle);
  const totalMs = performance.now() - start;

  const serverTiming = [
    `total;dur=${round(totalMs)}`,
    `db;dur=${round(timing.dbMs)};desc="${timing.dbCount} queries, ${timing.dbSequential} sequential"`,
    `dbsql;dur=${round(timing.dbSqlMs)}`,
    ...[...timing.spans].map(([name, ms]) => `${name};dur=${round(ms)}`),
  ].join(', ');

  const url = new URL(request.url);
  const cf = (request as { cf?: { colo?: string } }).cf;
  console.log(
    JSON.stringify({
      message: 'api_timing',
      method: request.method,
      route: routeKey(url.pathname),
      status: response.status,
      totalMs: round(totalMs),
      dbMs: round(timing.dbMs),
      dbSqlMs: round(timing.dbSqlMs),
      dbCount: timing.dbCount,
      dbSequential: timing.dbSequential,
      ...Object.fromEntries([...timing.spans].map(([name, ms]) => [`${name}Ms`, round(ms)])),
      colo: cf?.colo,
    }),
  );

  try {
    response.headers.append('Server-Timing', serverTiming);
    return response;
  } catch {
    const copy = new Response(response.body, response);
    copy.headers.append('Server-Timing', serverTiming);
    return copy;
  }
}
