import { drizzle } from 'drizzle-orm/d1';
import { and, eq, isNull } from 'drizzle-orm';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import * as schema from '../../../web/src/db/schema';
import type { McpScope } from '../../../web/src/server/mcp-scopes';
import { AgentInboxError } from '../../../web/src/server/agent-inbox';
import { reportError } from '../../../web/src/server/observability';
import {
  WebhookInputError,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  testWebhookEndpoint,
  updateWebhookEndpoint,
} from '../../../web/src/server/webhooks';
import { UserFacingError } from './errors';

export interface ApiEnv {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
}

/** What a REST call runs with: the token's account and access, and the MCP tools to do the work. */
export interface ApiContext {
  env: ApiEnv;
  userId: string;
  scopes: McpScope[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
}

interface ApiRequest {
  ctx: ApiContext;
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<Record<string, unknown>>;
}

interface ApiRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path after /v1, with `{name}` for a parameter, as in the OpenAPI document. */
  path: string;
  scope: McpScope;
  handle(req: ApiRequest): Promise<Response | unknown>;
}

export const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

export function apiJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS, ...headers },
  });
}

const CODES: Record<number, string> = {
  400: 'invalid_request',
  401: 'unauthorized',
  403: 'insufficient_scope',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  429: 'rate_limited',
  500: 'internal_error',
};

export function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return apiJson({ error: { code: CODES[status] ?? 'error', message } }, status, headers);
}

/** `kinds=meeting,note` or `kinds=meeting&kinds=note`. */
function listParam(query: URLSearchParams, name: string): string[] | undefined {
  const values = query.getAll(name).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  return values.length ? values : undefined;
}

/** The filters `recent` and `search` share, from the query string. */
function itemFilters(query: URLSearchParams): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const kinds = listParam(query, 'kinds');
  if (kinds) args.kinds = kinds;
  for (const name of ['project', 'since', 'until']) {
    const value = query.get(name);
    if (value !== null) args[name] = value;
  }
  const limit = query.get('limit');
  if (limit !== null) args.limit = Number(limit);
  return args;
}

function notFound(): never {
  throw new UserFacingError('not found', 404);
}

export const API_ROUTES: ApiRoute[] = [
  { method: 'GET', path: '/me', scope: 'read', handle: ({ ctx }) => ctx.call('get_account_info', {}) },
  { method: 'GET', path: '/projects', scope: 'read', handle: async ({ ctx }) => ({ projects: await ctx.call('list_projects', {}) }) },
  { method: 'GET', path: '/items', scope: 'read', handle: ({ ctx, query }) => ctx.call('recent', itemFilters(query)) },
  {
    method: 'GET',
    path: '/search',
    scope: 'read',
    handle: ({ ctx, query }) => {
      const q = query.get('q')?.trim();
      if (!q) throw new UserFacingError('q is required');
      return ctx.call('search', { ...itemFilters(query), query: q });
    },
  },
  {
    method: 'GET',
    path: '/items/{id}',
    scope: 'read',
    handle: ({ ctx, params, query }) => ctx.call('get', { id: params.id, transcript_format: query.get('transcript_format') ?? undefined }),
  },
  {
    method: 'GET',
    path: '/items/{id}/file',
    scope: 'read',
    handle: async ({ ctx, params }) => {
      if (!params.id.startsWith('cap_')) notFound();
      const db = drizzle(ctx.env.DB, { schema });
      const capture = (
        await db
          .select({ r2Key: schema.captures.r2Key, contentType: schema.captures.contentType })
          .from(schema.captures)
          .where(and(eq(schema.captures.id, params.id), eq(schema.captures.userId, ctx.userId), isNull(schema.captures.deletedAt)))
          .limit(1)
      )[0];
      const object = capture ? await ctx.env.AUDIO_BUCKET.get(capture.r2Key) : null;
      if (!capture || !object) notFound();
      return new Response(object.body as unknown as ReadableStream, {
        headers: {
          'content-type': capture.contentType,
          'content-length': String(object.size),
          'cache-control': 'private, no-store',
          ...CORS_HEADERS,
        },
      });
    },
  },
  {
    method: 'PATCH',
    path: '/items/{id}',
    scope: 'write',
    handle: async ({ ctx, params, body }) => {
      const input = await body();
      if (input.title === undefined && !('project' in input)) throw new UserFacingError('nothing to change: send title, project or both');
      let result: Record<string, unknown> = {};
      if (input.title !== undefined) result = { ...result, ...(await ctx.call('rename', { id: params.id, title: input.title })) as object };
      if ('project' in input) result = { ...result, ...(await ctx.call('set_project', { id: params.id, project: input.project })) as object };
      return result;
    },
  },
  {
    method: 'POST',
    path: '/notes',
    scope: 'write',
    handle: async ({ ctx, body }) => apiJson(await ctx.call('save_note', await body()), 201),
  },
  {
    method: 'GET',
    path: '/action-items',
    scope: 'read',
    handle: async ({ ctx, query }) => ({
      action_items: await ctx.call('get_action_items', { status: query.get('status') ?? undefined, owner: query.get('owner') ?? undefined }),
    }),
  },
  {
    method: 'PATCH',
    path: '/meetings/{id}/action-items/{index}',
    scope: 'write',
    handle: async ({ ctx, params, body }) => {
      const index = /^\d+$/.test(params.index) ? Number(params.index) : Number.NaN;
      return ctx.call('update_action_item', { ...(await body()), meeting_id: params.id, index });
    },
  },
  {
    method: 'GET',
    path: '/webhooks',
    scope: 'read',
    handle: async ({ ctx }) => ({ webhooks: await listWebhookEndpoints(drizzle(ctx.env.DB, { schema }), ctx.userId) }),
  },
  {
    method: 'POST',
    path: '/webhooks',
    scope: 'write',
    handle: async ({ ctx, body }) => apiJson(await createWebhookEndpoint(drizzle(ctx.env.DB, { schema }), ctx.userId, await body()), 201),
  },
  {
    method: 'GET',
    path: '/webhooks/{id}',
    scope: 'read',
    handle: async ({ ctx, params }) => (await getWebhookEndpoint(drizzle(ctx.env.DB, { schema }), ctx.userId, params.id)) ?? notFound(),
  },
  {
    method: 'PATCH',
    path: '/webhooks/{id}',
    scope: 'write',
    handle: async ({ ctx, params, body }) =>
      (await updateWebhookEndpoint(drizzle(ctx.env.DB, { schema }), ctx.userId, params.id, await body())) ?? notFound(),
  },
  {
    method: 'DELETE',
    path: '/webhooks/{id}',
    scope: 'write',
    handle: async ({ ctx, params }) => {
      if (!(await deleteWebhookEndpoint(drizzle(ctx.env.DB, { schema }), ctx.userId, params.id))) notFound();
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    },
  },
  {
    method: 'POST',
    path: '/webhooks/{id}/test',
    scope: 'write',
    handle: async ({ ctx, params }) => (await testWebhookEndpoint(drizzle(ctx.env.DB, { schema }), ctx.userId, params.id)) ?? notFound(),
  },
];

function match(route: ApiRoute, segments: string[]): Record<string, string> | null {
  const parts = route.path.split('/').filter(Boolean);
  if (parts.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const name = /^\{(\w+)\}$/.exec(parts[i])?.[1];
    if (name) params[name] = segments[i];
    else if (parts[i] !== segments[i]) return null;
  }
  return params;
}

/** Answers one authenticated call under /v1. `segments` is the path after /v1. */
export async function routeApi(request: Request, ctx: ApiContext, segments: string[]): Promise<Response> {
  let decoded: string[];
  try {
    decoded = segments.map(decodeURIComponent);
  } catch {
    return apiError(400, 'the path is not valid');
  }
  const matches = API_ROUTES.flatMap((route) => {
    const params = match(route, decoded);
    return params ? [{ route, params }] : [];
  });
  if (!matches.length) return apiError(404, 'no such endpoint; see /v1/openapi.json');
  const found = matches.find(({ route }) => route.method === request.method);
  if (!found) {
    return apiError(405, `use ${matches.map(({ route }) => route.method).join(', ')}`, {
      allow: matches.map(({ route }) => route.method).join(', '),
    });
  }
  const { route, params } = found;
  if (!ctx.scopes.includes(route.scope)) {
    return apiError(403, `this needs ${route.scope} access, and this key doesn't have it. Make a key with write access in Eavesy settings.`);
  }
  const body = async () => {
    const parsed: unknown = await request.json().catch(() => undefined);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UserFacingError('the body must be a JSON object');
    return parsed as Record<string, unknown>;
  };
  try {
    const result = await route.handle({ ctx, params, query: new URL(request.url).searchParams, body });
    return result instanceof Response ? result : apiJson(result);
  } catch (error) {
    if (error instanceof UserFacingError) return apiError(error.status, error.message);
    if (error instanceof WebhookInputError || error instanceof AgentInboxError) return apiError(400, error.message);
    reportError('REST API call failed', error, { route: `${route.method} ${route.path}` });
    return apiError(500, 'The request failed. Please try again.');
  }
}
