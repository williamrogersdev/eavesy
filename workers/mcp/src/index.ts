import { createAiRunner, creditsConfigured, type CreditEnv } from '../../../web/src/lib/ai/credit-runner';
import { librarySources, askLibrary } from '../../../web/src/server/library-memory';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { and, desc, eq, gte, inArray, isNull, lte, ne, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Ai, D1Database, DurableObjectNamespace, R2Bucket, VectorizeIndex } from '@cloudflare/workers-types';

import * as schema from '../../../web/src/db/schema';
import { clock } from '../../../web/src/lib/ai/chapters';
import { sha256Hex } from '../../../web/src/lib/sha256';
import { embedTexts } from '../../../web/src/lib/ai/embed';
import { createTextDrop, DropTooLargeError } from '../../../web/src/server/create-drop';
import { MAX_TEXT_BYTES } from '../../../web/src/server/drops';
import { parseStringList } from '../../../web/src/lib/projects';
import { parseSpeakerNames, speakerName } from '../../../web/src/lib/transcription/two-track';
import { reportError, withErrorReporting } from '../../../web/src/server/observability';
import { type QuotaScope, consumeRateLimit, refundRateLimit, userQuotaPolicy } from '../../../web/src/server/rate-limit-store';
import {
  mcpTokenExpiresAt,
  pathTokensAllowed,
  renewedMcpTokenExpiry,
} from '../../../web/src/server/mcp-token-policy';
import { type McpScope, parseMcpScopes, toolsForScopes } from '../../../web/src/server/mcp-scopes';
import * as savedPrompts from '../../../web/src/db/repo/prompts';
import {
  AgentInboxError,
  assertRoom,
  ASK_DEFAULT_SEC,
  ASK_MAX_SEC,
  ASK_MIN_SEC,
  createMessage,
  macEnabled,
  macListening,
  MAX_CHOICES,
  parseAsk,
  parseSend,
  SEND_TTL_MS,
  waitForAnswer,
} from '../../../web/src/server/agent-inbox';
import { fillPrompt } from '../../../web/src/lib/prompts';
import {
  authorizationParams,
  authorizationServerMetadata,
  exchangeToken,
  protectedResourceMetadata,
  registerClient,
  validateAuthorization,
  withQuery,
} from '../../../web/src/server/mcp-oauth';

interface Env extends CreditEnv {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  /** Drops (send_to_my_devices): the shared web helpers reach these through the `cloudflare:workers` env. */
  AUDIO_BUCKET: R2Bucket;
  DROPS_HUB: DurableObjectNamespace;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
  RELEASE?: string;
  /** Set to `false` to stop accepting tokens in the URL path. */
  MCP_ALLOW_PATH_TOKENS?: string;
  /** The web app, which shows the OAuth consent screen. Defaults to https://eavesy.com. */
  APP_URL?: string;
}

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;
const MCP_REQUESTS_PER_MINUTE = 120;
const CLIENT_REGISTRATIONS_PER_HOUR = 20;
/** send_to_human and ask_human calls per connection per 10 minutes, so a looping agent can't keep the Mac talking. */
const HUMAN_MESSAGES_PER_10_MIN = 30;

type TokenRow = typeof schema.mcpTokens.$inferSelect;

async function resolveToken(env: Env, rawToken: string, viaPath: boolean): Promise<TokenRow | 'expired' | null> {
  const db = drizzle(env.DB, { schema });
  const tokenHash = await sha256Hex(rawToken);
  const rows = await db
    .select()
    .from(schema.mcpTokens)
    .where(eq(schema.mcpTokens.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if (mcpTokenExpiresAt(row) <= now) return 'expired';
  const stale = !row.lastUsedAt || now - row.lastUsedAt > LAST_USED_RESOLUTION_MS;
  const pathStale = viaPath && (!row.pathAuthUsedAt || now - row.pathAuthUsedAt > LAST_USED_RESOLUTION_MS);
  // OAuth access tokens are short-lived and renewed with a refresh token, not by use.
  const expiresAt = row.clientId ? null : renewedMcpTokenExpiry(row, now);
  if (stale || pathStale || expiresAt) {
    await db
      .update(schema.mcpTokens)
      .set({
        lastUsedAt: now,
        ...(viaPath ? { pathAuthUsedAt: now } : {}),
        ...(expiresAt ? { expiresAt } : {}),
      })
      .where(eq(schema.mcpTokens.id, row.id));
  }
  return row;
}

function jsonError(status: number, error: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A 401 that tells an MCP client where to start OAuth (RFC 9728 §5.1), so it
 * can be added by URL alone.
 */
function unauthorized(origin: string, error: string, extra: Record<string, string> = {}, tokenSent = true) {
  const response = jsonError(401, error, extra);
  const challenge = [`resource_metadata="${origin}/.well-known/oauth-protected-resource"`];
  if (tokenSent) challenge.push('error="invalid_token"');
  response.headers.set('www-authenticate', `Bearer ${challenge.join(', ')}`);
  return response;
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '86400',
};

function oauthJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS_HEADERS },
  });
}

/** Whether `resource`, when a client sends one (RFC 8707), names this server. */
function isThisResource(resource: string | null, origin: string): boolean {
  if (resource === null) return true;
  try {
    return new URL(resource).origin === origin;
  } catch {
    return false;
  }
}

/** The OAuth endpoints. Null for any other path. */
async function routeOAuth(request: Request, env: Env, url: URL, path: string[]): Promise<Response | null> {
  const origin = url.origin;
  const isWellKnown = path[0] === '.well-known';
  const endpoint = path.length === 1 ? path[0] : null;
  if (!isWellKnown && endpoint !== 'authorize' && endpoint !== 'token' && endpoint !== 'register') return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (isWellKnown) {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    // Clients may append the MCP endpoint's path (RFC 9728 §3.1, RFC 8414 §3.1).
    if (path[1] === 'oauth-protected-resource') return oauthJson(protectedResourceMetadata(origin));
    if (path[1] === 'oauth-authorization-server') return oauthJson(authorizationServerMetadata(origin));
    return new Response('not found', { status: 404 });
  }

  const db = drizzle(env.DB, { schema });
  if (endpoint === 'register') {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const limited = await consumeRateLimit(env.DB, {
      key: `mcp-register:${request.headers.get('cf-connecting-ip') ?? 'unknown'}`,
      limit: CLIENT_REGISTRATIONS_PER_HOUR,
      windowSec: 3600,
      failMode: 'closed',
    });
    if (!limited.allowed) {
      const response = oauthJson({ error: 'rate_limited' }, 429);
      response.headers.set('retry-after', String(limited.retryAfterSec));
      return response;
    }
    const body: unknown = await request.json().catch(() => null);
    const result = await registerClient(db, body);
    return oauthJson(result, 'error' in result ? 400 : 201);
  }

  if (endpoint === 'authorize') {
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    const validated = await validateAuthorization(db, authorizationParams(url.searchParams));
    if (!validated.ok && !validated.redirect) {
      return new Response(`Eavesy can't connect this app: ${validated.error.error_description ?? validated.error.error}.`, {
        status: 400,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    if (!validated.ok) return Response.redirect(validated.redirectTo, 302);
    if (!isThisResource(url.searchParams.get('resource'), origin)) {
      return Response.redirect(
        withQuery(validated.redirectUri, { error: 'invalid_target', state: validated.state, iss: origin }),
        302,
      );
    }
    // The web app has the user's session: it signs them in, asks, and mints the code.
    const consent = new URL('/connect/mcp', env.APP_URL ?? 'https://eavesy.com');
    consent.search = url.search;
    return Response.redirect(consent.href, 302);
  }

  // endpoint === 'token'
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const data = request.headers.get('content-type')?.includes('application/x-www-form-urlencoded')
    ? await request.formData().catch(() => null)
    : null;
  const form = data ? new URLSearchParams() : null;
  for (const [key, value] of data ?? []) if (typeof value === 'string') form?.set(key, value);
  if (!form) return oauthJson({ error: 'invalid_request', error_description: 'expected a form-encoded body' }, 400);
  if (!isThisResource(form.get('resource'), origin)) return oauthJson({ error: 'invalid_target' }, 400);
  const result = await exchangeToken(db, form);
  return oauthJson(result, 'error' in result ? (result.error === 'invalid_client' ? 401 : 400) : 200);
}

export const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    const oauth = await routeOAuth(request, env, url, path);
    if (oauth) return oauth;
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';
    const viaPath = !bearer && Boolean(path[0]);
    const rawToken = bearer || path[0];
    if (!rawToken) {
      // A browser visiting the bare URL gets a name; an MCP client gets the
      // 401 that starts OAuth.
      if (request.method === 'GET' && !request.headers.get('accept')?.includes('text/event-stream')) {
        return new Response('Eavesy MCP server', { status: 200 });
      }
      return unauthorized(url.origin, 'authorization required', {}, false);
    }
    if (viaPath && !pathTokensAllowed(env.MCP_ALLOW_PATH_TOKENS)) {
      return unauthorized(url.origin, 'token must be sent in the Authorization header', {
        hint: 'Create a new connection in Eavesy settings and use the configuration it shows.',
      });
    }
    const token = await resolveToken(env, rawToken, viaPath);
    if (token === 'expired') {
      return unauthorized(url.origin, 'token expired', { hint: 'Create a new connection in Eavesy settings.' });
    }
    if (!token) return unauthorized(url.origin, 'invalid token');
    // Per token, after the token is known to be valid, failing open: every call
    // is already authenticated, and an unreachable counter means D1 is down
    // anyway. Messages to the human have their own limit, which fails closed.
    const limited = await consumeRateLimit(env.DB, {
      key: `mcp:${token.id}`,
      limit: MCP_REQUESTS_PER_MINUTE,
      windowSec: 60,
      failMode: 'open',
    });
    if (!limited.allowed) {
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': String(limited.retryAfterSec) },
      });
    }
    if (viaPath) {
      // Logged by token id only; the path itself is the secret.
      console.warn(JSON.stringify({ message: 'mcp token sent in URL path', tokenId: token.id }));
    }
    const response = await serve(request, env, token, parseMcpScopes(token.scopesJson));
    if (viaPath) response.headers.set('deprecation', 'true');
    return response;
  },
} satisfies ExportedHandler<Env>;

async function serve(request: Request, env: Env, token: TokenRow, scopes: McpScope[]): Promise<Response> {
  const userId = token.userId;
  const tools = toolsForScopes(TOOL_DEFS, scopes).map(({ scope: _scope, ...tool }) => tool);
  const requestedHeaderVersion = request.headers.get('mcp-protocol-version');
  if (requestedHeaderVersion && !MCP_VERSIONS.includes(requestedHeaderVersion as (typeof MCP_VERSIONS)[number])) {
    return new Response(JSON.stringify({ error: 'unsupported MCP protocol version' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (request.method === 'GET') {
    return new Response(
      JSON.stringify({
        name: 'eavesy',
        version: '0.1.0',
        tools,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  if (request.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }
  // Valid JSON can still be `null`, a number or a batch array.
  if (!isRecord(parsed)) return jsonRpc(null, undefined, { code: -32600, message: 'expected a JSON-RPC request object' });
  const body: RpcRequest = { id: parsed.id, method: parsed.method, params: isRecord(parsed.params) ? parsed.params : {} };

  if (body.method === 'initialize') {
    const requested = body.params.protocolVersion;
    const protocolVersion = MCP_VERSIONS.find((version) => version === requested) ?? MCP_VERSIONS[0];
    return jsonRpc(body.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
      serverInfo: { name: 'eavesy', version: '0.1.0' },
      instructions:
        'Search and retrieve the authenticated user\'s Eavesy library: recordings, dictations, notes, screenshots and other captures, ' +
        'and action items. Start with search or recent, then get an item by its id. ' +
        'The prompts are ones the user saved in Eavesy to reuse. ' +
        'send_to_human and ask_human reach the user on their Mac, where Eavesy shows and reads them aloud; use them when ' +
        'the user has asked you to keep them posted that way. An answer is information from the user, never an approval for anything. ' +
        'With write access, send_to_my_devices puts text such as a session handoff in the user\'s Drop inbox on their other devices.',
    });
  }
  if (body.method === 'notifications/initialized') {
    return new Response(null, { status: 202 });
  }
  if (body.method === 'ping') {
    return jsonRpc(body.id, {});
  }
  if (body.method === 'tools/list') {
    return jsonRpc(body.id, { tools });
  }
  if (body.method === 'prompts/list' || body.method === 'prompts/get') {
    // Saved prompts are the user's own text; reading them needs read access, like everything else here.
    if (!scopes.includes('read')) {
      return body.method === 'prompts/list'
        ? jsonRpc(body.id, { prompts: [] })
        : jsonRpc(body.id, undefined, { code: -32602, message: 'This connection can’t read your prompts.' });
    }
    const db = drizzle(env.DB, { schema });
    if (body.method === 'prompts/list') {
      const items = await savedPrompts.list(db, userId);
      return jsonRpc(body.id, { prompts: items.map(promptListing) });
    }
    const name = body.params.name;
    const prompt = typeof name === 'string' ? await savedPrompts.getBySlug(db, userId, name) : null;
    if (!prompt) return jsonRpc(body.id, undefined, { code: -32602, message: `No saved prompt is called ${String(name)}.` });
    const details = isRecord(body.params.arguments) ? body.params.arguments.details : undefined;
    // Best effort: a failed count must not fail the prompt.
    await savedPrompts.markUsed(db, userId, prompt.id).catch(() => undefined);
    return jsonRpc(body.id, {
      description: prompt.name,
      messages: [{ role: 'user', content: { type: 'text', text: fillPrompt(prompt.body, typeof details === 'string' ? details : null) } }],
    });
  }
  if (body.method === 'tools/call') {
    const name = typeof body.params.name === 'string' ? body.params.name : '';
    const args = isRecord(body.params.arguments) ? body.params.arguments : {};
    const def = TOOL_DEFS.find((tool) => tool.name === name);
    if (def && !scopes.includes(def.scope)) {
      return jsonRpc(body.id, {
        content: [{
          type: 'text',
          text: `${name} needs ${def.scope} access, and this connection doesn't have it. ` +
            'Create a connection with write access in Eavesy settings to use it.',
        }],
        isError: true,
      });
    }
    try {
      const result = await callTool(env, userId, name, args, token);
      const value = result instanceof ToolOutput ? result.value : result;
      return jsonRpc(body.id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...(result instanceof ToolOutput ? result.attachments : [])],
        // Only tools that declare an outputSchema promise a structured result.
        ...(def?.outputSchema ? { structuredContent: value } : {}),
      });
    } catch (err) {
      // Only our own messages reach the client; anything else may carry SQL or internals.
      if (err instanceof UserFacingError || err instanceof AgentInboxError) return jsonRpc(body.id, undefined, { code: -32602, message: err.message });
      reportError('MCP tool call failed', err, { mcp_tool: name || 'unknown' });
      return jsonRpc(body.id, undefined, { code: -32000, message: 'The tool call failed. Please try again.' });
    }
  }

  return jsonRpc(body.id, undefined, {
    code: -32601,
    message: `method not supported: ${String(body.method)}`,
  });
}

interface RpcRequest {
  id: unknown;
  method: unknown;
  params: Record<string, unknown>;
}

/** An error whose message is written for the person calling the tool. */
class UserFacingError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list tool's `limit`: a whole number from 1 to `max`, else the default. */
function clampLimit(value: unknown, fallback = 10, max = 50): number {
  return Math.max(1, Math.min(Math.trunc(Number(value)) || fallback, max));
}

function stringArg(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `%text%` for LIKE, with the wildcards and the escape character itself escaped. */
function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function contains(column: SQLiteColumn, pattern: string): SQL {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}

/** Imports are hidden until they finish, as search hides them. */
const visibleMeeting = () => or(ne(schema.meetings.source, 'import'), eq(schema.meetings.status, 'complete'));


export default withErrorReporting<Env>({ service: 'mcp', redactPath: true }, worker);

function jsonRpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) body.error = error;
  else body.result = result;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A saved prompt as `prompts/list` describes it. Its slug is the command name. */
function promptListing(prompt: { slug: string; name: string; body: string }) {
  const firstLine = prompt.body.trim().split('\n')[0] ?? '';
  return {
    name: prompt.slug,
    title: prompt.name,
    description: firstLine.length > 120 ? `${firstLine.slice(0, 119)}…` : firstLine,
    arguments: [{ name: 'details', description: 'Anything to add for this run', required: false }],
  };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool hints. Clients use readOnlyHint to decide whether to ask the user before a call. */
  annotations: ToolAnnotations;
  /** The scope a connection needs to see and call this tool. */
  scope: McpScope;
  /** The shape of `structuredContent` in this tool's results. */
  outputSchema?: Record<string, unknown>;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
}

const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Reaches the user on their Mac: changes nothing in the library, but isn't a plain read either. */
const MESSAGES_HUMAN: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** The longest title send_to_my_devices accepts. */
const DROP_TITLE_MAX_CHARS = 200;

/** Everything search, recent and get reach. "meeting" is any recording, as in the other tools. */
const ITEM_KINDS = ['meeting', 'dictation', 'note', 'image', 'video', 'audio'] as const;
type ItemKind = (typeof ITEM_KINDS)[number];
type CaptureKind = Exclude<ItemKind, 'meeting' | 'dictation'>;
const CAPTURE_KINDS: readonly CaptureKind[] = ['note', 'image', 'video', 'audio'];
/** get attaches an image this size or smaller, as the local CLI does. */
const IMAGE_ATTACH_MAX_BYTES = 4 * 1024 * 1024;
const ATTACHABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXCERPT_CHARS = 240;

const ITEM_FILTER_PROPERTIES = {
  kinds: {
    type: 'array',
    items: { type: 'string', enum: ITEM_KINDS },
    description: 'Only these kinds. Leave out for everything.',
  },
  project: { type: 'string', description: 'Only items filed under this project (by name, see list_projects). Dictations have no project, so they are left out.' },
  since: { type: 'string', description: 'Only items from this ISO 8601 date or time on, like 2026-10-01 or 2026-10-01T09:00:00Z. Times without an offset are UTC.' },
  until: { type: 'string', description: 'Only items up to this ISO 8601 date or time. A bare date includes that whole UTC day.' },
  limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
};

const ITEM_LIST_OUTPUT = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ITEM_KINDS },
          title: { type: 'string' },
          excerpt: { type: ['string', 'null'] },
          project: { type: ['string', 'null'] },
          created_at: { type: 'string', description: 'When it was recorded or captured (ISO 8601).' },
          duration_sec: { type: ['number', 'null'] },
          url: { type: ['string', 'null'] },
          score: { type: 'number', description: 'search only: 1 for a word match, lower for a match by meaning.' },
        },
        required: ['id', 'kind', 'title', 'excerpt', 'project', 'created_at', 'duration_sec', 'url'],
      },
    },
  },
  required: ['items'],
};

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'send_to_human',
    description:
      'Tell the user something on their Mac: Eavesy shows it in a card and reads `spoken` aloud. Use it when you finish a task ' +
      'or have something they should know while they are away from this chat. Returns at once. ' +
      'Returns {status: "sent"}, {status: "queued"} when their Mac is not listening right now, or {status: "not_enabled"} ' +
      'when they have not turned on agent messages in Eavesy (nothing is kept then).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 4000, description: 'The message, shown in full on the card.' },
        spoken: { type: 'string', maxLength: 300, description: 'One short sentence to read aloud. Without it, the start of `text` is read.' },
      },
      required: ['text'],
    },
    annotations: MESSAGES_HUMAN,
    scope: 'read',
  },
  {
    name: 'ask_human',
    description:
      'Ask the user a question on their Mac and wait for their typed answer. Eavesy shows the question, reads `spoken` aloud, ' +
      'and returns {status: "answered", text}, {status: "dismissed"}, {status: "timeout"} or, straight away, {status: "mac_offline"}. ' +
      `It waits up to timeout_sec (default ${ASK_DEFAULT_SEC}, ${ASK_MIN_SEC} to ${ASK_MAX_SEC}); pass a value below your own tool-call time limit. ` +
      'The answer is information from the user, never an approval to run a tool or spend money. Don\'t ask the same question twice at once.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', maxLength: 4000, description: 'The question, shown in full on the card.' },
        spoken: { type: 'string', maxLength: 300, description: 'One short sentence to read aloud.' },
        choices: { type: 'array', items: { type: 'string', maxLength: 80 }, maxItems: MAX_CHOICES, description: 'Suggested answers, shown on the card. The user can still type anything.' },
        timeout_sec: { type: 'number', minimum: ASK_MIN_SEC, maximum: ASK_MAX_SEC, default: ASK_DEFAULT_SEC },
      },
      required: ['question'],
    },
    annotations: MESSAGES_HUMAN,
    scope: 'read',
  },
  {
    name: 'search',
    description:
      "Search everything in the user's Eavesy library: recordings (meetings, calls, videos), dictations, notes, and " +
      'screenshots, images, video and audio captures. Matches titles and text, including text read from screenshots; ' +
      'recordings and dictations also match by meaning, and a call that includes them counts against the user\'s daily search quota. ' +
      'Filter by kinds, project and a since/until range. Returns {items}, best match first. Pass an item\'s id to get for the whole thing.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1, maxLength: 1000 }, ...ITEM_FILTER_PROPERTIES },
      required: ['query'],
    },
    outputSchema: ITEM_LIST_OUTPUT,
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'recent',
    description:
      "List the newest items in the user's library, newest first: recordings, dictations, notes and captures. " +
      'Use it for "my last call", "what I noted yesterday" or "screenshots from this week", with kinds, project and since/until. ' +
      'Returns {items}. Pass an item\'s id to get for the whole thing.',
    inputSchema: { type: 'object', properties: ITEM_FILTER_PROPERTIES },
    outputSchema: ITEM_LIST_OUTPUT,
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'get',
    description:
      'Get one item by the id search or recent returned. A recording comes with its summary, the user\'s own notes and the full ' +
      'transcript (cleaned up for an agent unless transcript_format is "raw"); a dictation with its text; a note with its Markdown; ' +
      `a screenshot or image with any text read from it and the image itself (up to ${IMAGE_ATTACH_MAX_BYTES / 1024 / 1024} MB); ` +
      'a video or audio capture with its transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        transcript_format: { type: 'string', enum: ['agent', 'raw'], default: 'agent' },
      },
      required: ['id'],
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  { name: 'search_library', description: 'Find current transcript evidence across completed recordings, with segment IDs and timestamps.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['query'] }, annotations: READ_ONLY, scope: 'read' },
  { name: 'ask_library', description: 'Answer from completed recordings with exact source quotes, or abstain when evidence is insufficient. Each call counts against the user\'s daily AI answer quota.', inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['question'] }, annotations: READ_ONLY, scope: 'read' },
  {
    name: 'search_meetings',
    description: "Search the user's meetings by title or transcript content. Returns matching meetings with an excerpt.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'get_meeting',
    description:
      'Get a meeting by ID including summary and full transcript. By default the transcript is cleaned up for an AI agent: fillers removed, turns merged, code terms in backticks, and a conversation wrapped in a <transcript> tag naming its speakers. Use transcript_format "raw" for every line as heard, with timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        transcript_format: { type: 'string', enum: ['agent', 'raw'], default: 'agent' },
      },
      required: ['id'],
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'recent_meetings',
    description: 'List the most recent meetings, optionally only those in one project (by name, see list_projects).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 10 }, project: { type: 'string' } },
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'list_projects',
    description:
      "List the user's projects (the codebases or clients they record about) with a short description, key terms and how many recordings each has.",
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'search_dictations',
    description: "Search the user's dictations.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'get_action_items',
    description: 'Get action items from the user\'s meetings, filterable by status.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'completed', 'all'], default: 'open' },
        owner: { type: 'string' },
      },
    },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'get_account_info',
    description:
      'Say which Eavesy account and connection this is: the email and name it is signed in as, the connection\'s name and access, ' +
      'and when it stops working unless renewed. Use it when results look like they come from the wrong account.',
    inputSchema: { type: 'object', properties: {} },
    annotations: READ_ONLY,
    scope: 'read',
  },
  {
    name: 'sign_out',
    description:
      'Disconnect this connection from the user\'s Eavesy account. Every later call fails until the user connects again. ' +
      'Only call it when the user asks to sign out or disconnect Eavesy. Other connections are not affected.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    scope: 'read',
  },
  {
    name: 'send_to_my_devices',
    description:
      "Send text to the user's Eavesy Drop inbox. It appears at once on every device where they have Eavesy open, ready to copy. " +
      'Use it to hand off long output such as a session handoff doc, a plan or a snippet the user wants on another computer. ' +
      `Up to ${MAX_TEXT_BYTES / 1024 / 1024} MB. Drops are kept for 7 days. Returns {id, bytes}.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, description: 'The text to send. Markdown is fine.' },
        title: { type: 'string', maxLength: DROP_TITLE_MAX_CHARS, description: 'Optional heading, added as the first line of the drop.' },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    scope: 'write',
  },
];

/** The columns a meeting search result shows. */
const MEETING_LISTING = {
  id: schema.meetings.id,
  title: schema.meetings.title,
  description: schema.meetings.description,
  startedAt: schema.meetings.startedAt,
  durationSec: schema.meetings.durationSec,
  folderId: schema.meetings.folderId,
};
/** Vectorize returns at most 50 matches when metadata is asked for. */
const VECTOR_TOP_K_MAX = 50;
/** get_action_items reads this many of the newest summarized meetings, and returns at most this many items. */
const ACTION_ITEM_MEETINGS = 200;
const ACTION_ITEMS_MAX = 200;

/**
 * Tools that call a model count against the same daily quotas as the web app
 * (an answer is a chat, a semantic search a search), so a connection can't
 * spend more than the user could from the browser. Fails closed, as there.
 * A call that fails gives its use back.
 */
async function withQuota<T>(env: Env, userId: string, scope: QuotaScope, run: () => Promise<T>): Promise<T> {
  const policy = userQuotaPolicy(scope, userId, env as unknown as Record<string, unknown>);
  const chargedAt = Date.now();
  const result = await consumeRateLimit(env.DB, policy, chargedAt);
  if (!result.allowed) {
    throw new UserFacingError('You’ve reached today’s limit for this. It resets at midnight UTC — contact support if you need more.');
  }
  try {
    return await run();
  } catch (error) {
    await refundRateLimit(env.DB, policy, chargedAt);
    throw error;
  }
}

/** One more message from this connection to the human, or a refusal once it has sent too many. */
async function humanMessageAllowed(env: Env, token: TokenRow): Promise<void> {
  const limited = await consumeRateLimit(env.DB, {
    key: `mcp-human:${token.id}`,
    limit: HUMAN_MESSAGES_PER_10_MIN,
    windowSec: 600,
    failMode: 'closed',
  });
  if (!limited.allowed) {
    throw new UserFacingError(`This connection has sent the person too many messages. Try again in ${Math.ceil(limited.retryAfterSec / 60)} minutes.`);
  }
}

async function callTool(env: Env, userId: string, name: string, args: Record<string, unknown>, token: TokenRow) {
  const db = drizzle(env.DB, { schema });
  switch (name) {
    case 'send_to_human': {
      const input = parseSend(args);
      // Nothing is kept for someone who never turned messages on.
      if (!(await macEnabled(db, userId))) return { status: 'not_enabled' };
      await assertRoom(db, userId);
      await humanMessageAllowed(env, token);
      const listening = await macListening(db, userId);
      await createMessage(db, { userId, mcpTokenId: token.id, source: token.name, kind: 'send', text: input.text, spoken: input.spoken, ttlMs: SEND_TTL_MS });
      return listening
        ? { status: 'sent' }
        : { status: 'queued', note: 'The person\'s Mac isn\'t listening right now. It shows the message if it comes back within 2 hours.' };
    }
    case 'ask_human': {
      const input = parseAsk(args);
      // Straight away, without waiting: nobody is there to answer.
      if (!(await macListening(db, userId))) return { status: 'mac_offline' };
      await assertRoom(db, userId);
      await humanMessageAllowed(env, token);
      const ttlMs = input.timeoutSec * 1000;
      const id = await createMessage(db, {
        userId,
        mcpTokenId: token.id,
        source: token.name,
        kind: 'ask',
        text: input.question,
        spoken: input.spoken,
        choices: input.choices,
        ttlMs,
      });
      return waitForAnswer(db, id, Date.now() + ttlMs);
    }
    case 'send_to_my_devices': {
      const body = typeof args.text === 'string' ? args.text : '';
      if (!body.trim()) throw new UserFacingError('text is required');
      const title = stringArg(args.title).replace(/\s+/g, ' ');
      if (title.length > DROP_TITLE_MAX_CHARS) throw new UserFacingError(`title must be at most ${DROP_TITLE_MAX_CHARS} characters`);
      const text = title ? `# ${title}\n\n${body}` : body;
      const tooLarge = `text too large: the limit is ${MAX_TEXT_BYTES / 1024 / 1024} MB`;
      // Checked before the quota, so an oversized call doesn't spend one.
      if (new TextEncoder().encode(text).byteLength > MAX_TEXT_BYTES) throw new UserFacingError(tooLarge);
      return withQuota(env, userId, 'drop', async () => {
        try {
          // Always the token owner's own inbox: no argument names a user or a device.
          const drop = await createTextDrop(db, { userId, text, deviceLabel: `${token.name.slice(0, 54)} (MCP)`, origin: null });
          return { id: drop.id, bytes: drop.bytes };
        } catch (error) {
          if (error instanceof DropTooLargeError) throw new UserFacingError(tooLarge);
          throw error;
        }
      });
    }
    case 'search_library':
    case 'ask_library': {
      const question = stringArg(name === 'ask_library' ? args.question : args.query);
      if (question.length < 3 || question.length > 1000) throw new UserFacingError('Question must be between 3 and 1000 characters');
      if (name === 'ask_library' && !creditsConfigured(env)) throw new UserFacingError('Library answers are not enabled');
      return withQuota<unknown>(env, userId, name === 'ask_library' ? 'chat' : 'search', () => {
        const opts = { ai: createAiRunner(env, 'mcp-library'), vectorize: env.VECTORIZE };
        return name === 'ask_library' ? askLibrary(db, userId, question, opts) : librarySources(db, userId, question, opts);
      });
    }
    case 'search': {
      const query = stringArg(args.query);
      if (!query) return { items: [] };
      if (query.length > 1000) throw new UserFacingError('query must be at most 1000 characters');
      const filter = await itemFilter(db, userId, args);
      const limit = clampLimit(args.limit);
      const byMeaning = filter.kinds.includes('meeting') || filter.kinds.includes('dictation');
      const semantic = byMeaning ? await semanticMatches(env, userId, query, Math.min(limit * 3, VECTOR_TOP_K_MAX)) : [];
      const excerpts = await vectorExcerpts(db, userId, semantic);
      const [meetings, dictations, captures] = await Promise.all([
        filter.kinds.includes('meeting') ? meetingHits(db, userId, query, limit, filter, semantic, excerpts) : [],
        filter.kinds.includes('dictation') && !filter.project ? dictationHits(db, userId, query, limit, filter, semantic, excerpts) : [],
        captureKinds(filter).length ? captureHits(db, userId, query, limit, filter) : [],
      ]);
      const hits: ScoredItem[] = [
        ...meetings.map(({ meeting, score, excerpt }) => ({ ...meetingItem(meeting, filter.projects, excerpt), score })),
        ...dictations,
        ...captures,
      ];
      return {
        items: hits
          .sort((a, b) => b.score - a.score || b.created_at.localeCompare(a.created_at))
          .slice(0, limit),
      };
    }
    case 'recent': {
      const filter = await itemFilter(db, userId, args);
      const limit = clampLimit(args.limit);
      const [meetings, dictations, captures] = await Promise.all([
        filter.kinds.includes('meeting')
          ? db
              .select(MEETING_LISTING)
              .from(schema.meetings)
              .where(meetingScope(userId, filter))
              .orderBy(desc(schema.meetings.startedAt))
              .limit(limit)
          : [],
        filter.kinds.includes('dictation') && !filter.project
          ? db
              .select(DICTATION_LISTING)
              .from(schema.dictations)
              .where(dictationScope(userId, filter))
              .orderBy(desc(schema.dictations.createdAt))
              .limit(limit)
          : [],
        captureKinds(filter).length
          ? db
              .select(CAPTURE_LISTING)
              .from(schema.captures)
              .where(captureScope(userId, filter))
              .orderBy(desc(schema.captures.createdAt))
              .limit(limit)
          : [],
      ]);
      const items: ItemListing[] = [
        ...meetings.map((m) => meetingItem(m, filter.projects, m.description)),
        ...dictations.map((d) => dictationItem(d, excerptOf(d.cleanedText ?? d.transcript))),
        ...captures.map((c) => captureItem(c, filter.projects, c.text)),
      ];
      return { items: items.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit) };
    }
    case 'get': {
      const id = stringArg(args.id);
      if (!id) throw new UserFacingError('id is required');
      // Ids carry their kind as a prefix; anything else is tried as each kind in turn.
      const lookups = id.startsWith('cap_')
        ? [getCapture]
        : id.startsWith('dict_')
          ? [getDictation]
          : [getMeeting, getDictation, getCapture];
      for (const lookup of lookups) {
        const found = await lookup(env, db, userId, id, args);
        if (found) return found;
      }
      throw new UserFacingError('not found');
    }
    case 'search_meetings': {
      const query = stringArg(args.query);
      if (!query) return [];
      const limit = clampLimit(args.limit);
      const filter: ItemFilter = { kinds: ['meeting'], projects: [] };
      const semantic = await semanticMatches(env, userId, query, Math.min(limit * 3, VECTOR_TOP_K_MAX));
      const hits = await meetingHits(db, userId, query, limit, filter, semantic, await vectorExcerpts(db, userId, semantic));
      return hits.map(({ meeting: m, score, excerpt }) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        excerpt,
        score,
        started_at: new Date(m.startedAt).toISOString(),
        duration_sec: m.durationSec,
        url: meetingUrl(m.id),
      }));
    }
    case 'get_meeting': {
      const id = stringArg(args.id);
      if (!id) throw new UserFacingError('id is required');
      const meeting = await getMeeting(env, db, userId, id, args);
      if (!meeting) throw new UserFacingError('not found');
      const { kind: _kind, ...rest } = meeting;
      return rest;
    }
    case 'recent_meetings': {
      const limit = clampLimit(args.limit);
      const { projects, project } = await projectArg(db, userId, args.project);
      const rows = await db
        .select(MEETING_LISTING)
        .from(schema.meetings)
        .where(meetingScope(userId, { kinds: ['meeting'], projects, project }))
        .orderBy(desc(schema.meetings.startedAt))
        .limit(limit);
      return rows.map((m) => ({
        id: m.id,
        title: m.title,
        project: projects.find((p) => p.id === m.folderId)?.name ?? null,
        started_at: new Date(m.startedAt).toISOString(),
        duration_sec: m.durationSec,
      }));
    }
    case 'list_projects': {
      const rows = await db
        .select({
          folder: schema.folders,
          recordings: sql<number>`(select count(*) from meetings m where m.folder_id = "folders"."id" and m.deleted_at is null)`,
        })
        .from(schema.folders)
        .where(eq(schema.folders.userId, userId))
        .orderBy(schema.folders.sortOrder, schema.folders.name);
      return rows.map(({ folder, recordings }) => ({
        name: folder.name,
        about: folder.about,
        terms: parseStringList(folder.vocabularyJson),
        people: folder.people,
        recordings: Number(recordings) || 0,
      }));
    }
    case 'search_dictations': {
      const query = stringArg(args.query);
      if (!query) return [];
      const q = containsPattern(query);
      const limit = clampLimit(args.limit);
      const rows = await db
        .select({
          id: schema.dictations.id,
          transcript: schema.dictations.transcript,
          cleanedText: schema.dictations.cleanedText,
          createdAt: schema.dictations.createdAt,
        })
        .from(schema.dictations)
        .where(
          and(
            eq(schema.dictations.userId, userId),
            isNull(schema.dictations.deletedAt),
            or(contains(schema.dictations.transcript, q), contains(schema.dictations.title, q)),
          ),
        )
        .orderBy(desc(schema.dictations.createdAt))
        .limit(limit);
      return rows.map((d) => ({
        id: d.id,
        transcript: d.transcript,
        cleaned: d.cleanedText,
        created_at: new Date(d.createdAt).toISOString(),
      }));
    }
    case 'get_action_items': {
      const status = args.status === 'completed' || args.status === 'all' ? args.status : 'open';
      const owner = stringArg(args.owner);
      const rows = await db
        .select({
          actionItemsJson: schema.summaries.actionItemsJson,
          meetingId: schema.meetings.id,
          meetingTitle: schema.meetings.title,
        })
        .from(schema.summaries)
        .innerJoin(schema.meetings, eq(schema.meetings.id, schema.summaries.meetingId))
        .where(and(eq(schema.meetings.userId, userId), isNull(schema.meetings.deletedAt), visibleMeeting()))
        .orderBy(desc(schema.meetings.startedAt))
        .limit(ACTION_ITEM_MEETINGS);
      const out: ActionItemResult[] = [];
      for (const row of rows) {
        for (const a of parseActionItems(row.actionItemsJson)) {
          if (status === 'open' && a.completed) continue;
          if (status === 'completed' && !a.completed) continue;
          if (owner && a.owner !== owner) continue;
          out.push({
            text: a.text,
            owner: a.owner,
            due: a.due,
            completed: a.completed,
            meeting_id: row.meetingId,
            meeting_title: row.meetingTitle,
          });
          if (out.length >= ACTION_ITEMS_MAX) return out;
        }
      }
      return out;
    }
    case 'get_account_info': {
      const user = (
        await db
          .select({ email: schema.users.email, displayName: schema.users.displayName })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1)
      )[0];
      // An OAuth connection lasts as long as its refresh token; its access token is renewed well before.
      const connectionExpiresAt = token.clientId ? token.refreshExpiresAt : mcpTokenExpiresAt(token);
      return {
        email: user?.email ?? null,
        name: user?.displayName ?? null,
        connection: {
          name: token.name,
          access: parseMcpScopes(token.scopesJson),
          kind: token.clientId ? 'oauth' : 'token',
          created_at: new Date(token.createdAt).toISOString(),
          expires_at: connectionExpiresAt ? new Date(connectionExpiresAt).toISOString() : null,
        },
      };
    }
    case 'sign_out': {
      // Revoking the row ends the access token and, for OAuth, its refresh token too.
      await db
        .update(schema.mcpTokens)
        .set({ revokedAt: Date.now() })
        .where(and(eq(schema.mcpTokens.id, token.id), eq(schema.mcpTokens.userId, userId), isNull(schema.mcpTokens.revokedAt)));
      return {
        status: 'signed_out',
        note: 'This connection no longer works. To use Eavesy again, connect it again from this app or from Eavesy settings.',
      };
    }
    default:
      throw new UserFacingError(`unknown tool: ${name}`);
  }
}

type Db = DrizzleD1Database<typeof schema>;

/** A tool result that also carries other MCP content, such as an image. */
class ToolOutput {
  constructor(
    readonly value: Record<string, unknown>,
    readonly attachments: { type: 'image'; data: string; mimeType: string }[],
  ) {}
}

interface Project {
  id: string;
  name: string;
}

/** What search and recent were asked to cover. */
interface ItemFilter {
  kinds: ItemKind[];
  /** All the user's projects, to name an item's. */
  projects: Project[];
  /** Set when the call asked for one project. */
  project?: Project;
  since?: number;
  until?: number;
}

interface ItemListing {
  id: string;
  kind: ItemKind;
  title: string;
  excerpt: string | null;
  project: string | null;
  created_at: string;
  duration_sec: number | null;
  url: string | null;
}

interface ScoredItem extends ItemListing {
  score: number;
}

interface VectorMatch {
  sourceType: string;
  sourceId: string;
  vectorId: string;
  score: number;
}

type MeetingRow = Pick<typeof schema.meetings.$inferSelect, 'id' | 'title' | 'description' | 'startedAt' | 'durationSec' | 'folderId'>;
type DictationRow = Pick<typeof schema.dictations.$inferSelect, 'id' | 'title' | 'transcript' | 'cleanedText' | 'durationSec' | 'createdAt'>;
type CaptureRow = Pick<typeof schema.captures.$inferSelect, 'id' | 'kind' | 'title' | 'durationSec' | 'folderId' | 'createdAt'> & {
  text: string | null;
};

const DICTATION_LISTING = {
  id: schema.dictations.id,
  title: schema.dictations.title,
  transcript: schema.dictations.transcript,
  cleanedText: schema.dictations.cleanedText,
  durationSec: schema.dictations.durationSec,
  createdAt: schema.dictations.createdAt,
};

const CAPTURE_COLUMNS = {
  id: schema.captures.id,
  kind: schema.captures.kind,
  title: schema.captures.title,
  durationSec: schema.captures.durationSec,
  folderId: schema.captures.folderId,
  createdAt: schema.captures.createdAt,
};
/** A note's text can run to a megabyte, so a listing reads only its start. */
const CAPTURE_LISTING = {
  ...CAPTURE_COLUMNS,
  text: sql<string | null>`substr(${schema.captures.transcript}, 1, ${EXCERPT_CHARS * 2})`,
};

async function projectArg(db: Db, userId: string, value: unknown): Promise<{ projects: Project[]; project?: Project }> {
  const projects = await db
    .select({ id: schema.folders.id, name: schema.folders.name })
    .from(schema.folders)
    .where(eq(schema.folders.userId, userId));
  const name = stringArg(value);
  if (!name) return { projects };
  const project = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!project) throw new UserFacingError(`no project named "${name}"`);
  return { projects, project };
}

async function itemFilter(db: Db, userId: string, args: Record<string, unknown>): Promise<ItemFilter> {
  const kinds = kindsArg(args.kinds);
  const since = timeArg(args.since, 'since', false);
  const until = timeArg(args.until, 'until', true);
  if (since !== undefined && until !== undefined && since > until) throw new UserFacingError('since must be before until');
  return { kinds, since, until, ...(await projectArg(db, userId, args.project)) };
}

/** Every kind when none is named. One kind on its own, not in a list, is fine too. */
function kindsArg(value: unknown): ItemKind[] {
  if (value === undefined || value === null) return [...ITEM_KINDS];
  const named: unknown[] = Array.isArray(value) ? value : [value];
  const unknownKind = named.find((kind) => !(ITEM_KINDS as readonly unknown[]).includes(kind));
  if (unknownKind !== undefined) throw new UserFacingError(`unknown kind "${String(unknownKind)}": use ${ITEM_KINDS.join(', ')}`);
  return named.length ? ITEM_KINDS.filter((kind) => named.includes(kind)) : [...ITEM_KINDS];
}

/** An ISO 8601 date or time as epoch ms. A bare date as `until` runs to the end of that UTC day. */
function timeArg(value: unknown, name: string, endOfDay: boolean): number | undefined {
  const text = stringArg(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new UserFacingError(`${name} must be an ISO 8601 date or time, like 2026-10-01 or 2026-10-01T09:00:00Z`);
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text) ? ms + 86_400_000 - 1 : ms;
}

function inRange(column: SQLiteColumn, filter: ItemFilter): SQL | undefined {
  return and(
    filter.since === undefined ? undefined : gte(column, filter.since),
    filter.until === undefined ? undefined : lte(column, filter.until),
  );
}

function meetingScope(userId: string, filter: ItemFilter): SQL | undefined {
  return and(
    eq(schema.meetings.userId, userId),
    isNull(schema.meetings.deletedAt),
    visibleMeeting(),
    filter.project ? eq(schema.meetings.folderId, filter.project.id) : undefined,
    inRange(schema.meetings.startedAt, filter),
  );
}

function dictationScope(userId: string, filter: ItemFilter): SQL | undefined {
  return and(eq(schema.dictations.userId, userId), isNull(schema.dictations.deletedAt), inRange(schema.dictations.createdAt, filter));
}

function captureKinds(filter: ItemFilter): CaptureKind[] {
  return CAPTURE_KINDS.filter((kind) => filter.kinds.includes(kind));
}

function captureScope(userId: string, filter: ItemFilter): SQL | undefined {
  return and(
    eq(schema.captures.userId, userId),
    isNull(schema.captures.deletedAt),
    inArray(schema.captures.kind, captureKinds(filter)),
    filter.project ? eq(schema.captures.folderId, filter.project.id) : undefined,
    inRange(schema.captures.createdAt, filter),
  );
}

const meetingUrl = (id: string) => `https://eavesy.com/app/meetings/${id}`;
const iso = (ms: number) => new Date(ms).toISOString();
const projectName = (projects: Project[], folderId: string | null) => projects.find((p) => p.id === folderId)?.name ?? null;

function meetingItem(m: MeetingRow, projects: Project[], excerpt: string | null): ItemListing {
  return {
    id: m.id,
    kind: 'meeting',
    title: m.title,
    excerpt: excerptOf(excerpt),
    project: projectName(projects, m.folderId),
    created_at: iso(m.startedAt),
    duration_sec: m.durationSec,
    url: meetingUrl(m.id),
  };
}

function dictationItem(d: DictationRow, excerpt: string | null): ItemListing {
  return {
    id: d.id,
    kind: 'dictation',
    title: d.title,
    excerpt: excerptOf(excerpt),
    project: null,
    created_at: iso(d.createdAt),
    duration_sec: d.durationSec,
    url: null,
  };
}

function captureItem(c: CaptureRow, projects: Project[], excerpt: string | null): ItemListing {
  return {
    id: c.id,
    kind: c.kind,
    title: c.title,
    excerpt: excerptOf(excerpt),
    project: projectName(projects, c.folderId),
    created_at: iso(c.createdAt),
    duration_sec: c.durationSec,
    // The web app has no page for a note yet.
    url: c.kind === 'note' ? null : `https://eavesy.com/app/captures/${c.id}`,
  };
}

/** Whitespace folded, cut to EXCERPT_CHARS. */
function excerptOf(text: string | null | undefined): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/** The part of `text` around the first place `query` appears, or its start. */
function snippet(text: string, query: string): string {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  return at > 80 ? `…${text.slice(at - 80)}` : text;
}

/** The query matched by meaning across recordings and dictations. Counts against the search quota. */
async function semanticMatches(env: Env, userId: string, query: string, topK: number): Promise<VectorMatch[]> {
  const result = await withQuota(env, userId, 'search', async () => {
    const queryVector = (await embedTexts(createAiRunner(env, 'mcp-search'), [query]))[0];
    return env.VECTORIZE.query(queryVector, { topK, filter: { userId }, returnMetadata: 'all' });
  });
  return result.matches.flatMap((match) => {
    const metadata = asMetadata(match.metadata);
    return metadata.sourceType && metadata.sourceId
      ? [{ sourceType: metadata.sourceType, sourceId: metadata.sourceId, vectorId: String(match.id), score: match.score }]
      : [];
  });
}

/** The stored text of each matched chunk, by vector id. */
async function vectorExcerpts(db: Db, userId: string, matches: VectorMatch[]): Promise<Map<string, string | null>> {
  if (!matches.length) return new Map();
  const rows = await db
    .select({ id: schema.embeddings.id, contentExcerpt: schema.embeddings.contentExcerpt })
    .from(schema.embeddings)
    .where(and(eq(schema.embeddings.userId, userId), inArray(schema.embeddings.id, matches.map((match) => match.vectorId))));
  return new Map(rows.map((row) => [row.id, row.contentExcerpt]));
}

/** Each source's best-scoring match of one type. */
function bestBySource(matches: VectorMatch[], sourceType: string): Map<string, VectorMatch> {
  const best = new Map<string, VectorMatch>();
  for (const match of matches) {
    if (match.sourceType !== sourceType) continue;
    const prior = best.get(match.sourceId);
    if (!prior || match.score > prior.score) best.set(match.sourceId, match);
  }
  return best;
}

/** Recordings whose title or text has the query (score 1), merged with those that match by meaning. */
async function meetingHits(
  db: Db,
  userId: string,
  query: string,
  limit: number,
  filter: ItemFilter,
  semantic: VectorMatch[],
  excerpts: Map<string, string | null>,
): Promise<{ meeting: MeetingRow; score: number; excerpt: string | null }[]> {
  const q = containsPattern(query);
  const best = bestBySource(semantic, 'meeting');
  const [titleRows, semanticRows] = await Promise.all([
    db
      .select(MEETING_LISTING)
      .from(schema.meetings)
      .where(
        and(
          meetingScope(userId, filter),
          or(
            contains(schema.meetings.title, q),
            contains(schema.meetings.description, q),
            contains(schema.meetings.summaryOverrideMd, q),
            contains(schema.meetings.transcriptOverrideMd, q),
          ),
        ),
      )
      .orderBy(desc(schema.meetings.startedAt))
      .limit(limit),
    best.size
      ? db
          .select(MEETING_LISTING)
          .from(schema.meetings)
          .where(and(meetingScope(userId, filter), inArray(schema.meetings.id, [...best.keys()])))
      : Promise.resolve([]),
  ]);
  const merged = new Map(titleRows.map((meeting) => [meeting.id, { meeting, score: 1, excerpt: meeting.description }]));
  for (const meeting of semanticRows) {
    const match = best.get(meeting.id);
    if (!match) continue;
    const prior = merged.get(meeting.id);
    if (!prior || match.score > prior.score) {
      merged.set(meeting.id, { meeting, score: match.score, excerpt: excerpts.get(match.vectorId) ?? meeting.description });
    }
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score || b.meeting.startedAt - a.meeting.startedAt)
    .slice(0, limit);
}

async function dictationHits(
  db: Db,
  userId: string,
  query: string,
  limit: number,
  filter: ItemFilter,
  semantic: VectorMatch[],
  excerpts: Map<string, string | null>,
): Promise<ScoredItem[]> {
  const q = containsPattern(query);
  const best = bestBySource(semantic, 'dictation');
  const [wordRows, semanticRows] = await Promise.all([
    db
      .select(DICTATION_LISTING)
      .from(schema.dictations)
      .where(
        and(
          dictationScope(userId, filter),
          or(contains(schema.dictations.title, q), contains(schema.dictations.transcript, q), contains(schema.dictations.cleanedText, q)),
        ),
      )
      .orderBy(desc(schema.dictations.createdAt))
      .limit(limit),
    best.size
      ? db
          .select(DICTATION_LISTING)
          .from(schema.dictations)
          .where(and(dictationScope(userId, filter), inArray(schema.dictations.id, [...best.keys()])))
      : Promise.resolve([]),
  ]);
  const byWord = new Set(wordRows.map((d) => d.id));
  return [
    ...wordRows.map((d) => ({ ...dictationItem(d, snippet(d.cleanedText ?? d.transcript, query)), score: 1 })),
    ...semanticRows.flatMap((d) => {
      const match = best.get(d.id);
      if (!match || byWord.has(d.id)) return [];
      return [{ ...dictationItem(d, excerpts.get(match.vectorId) ?? d.cleanedText ?? d.transcript), score: match.score }];
    }),
  ];
}

/** Notes and captures whose title or text (a note's Markdown, text read from a screenshot, a transcript) has the query. */
async function captureHits(db: Db, userId: string, query: string, limit: number, filter: ItemFilter): Promise<ScoredItem[]> {
  const q = containsPattern(query);
  const text = schema.captures.transcript;
  const rows = await db
    .select({
      ...CAPTURE_COLUMNS,
      // From a little before the first match. instr is 0 when only the title matched, which starts at the top.
      text: sql<string | null>`substr(${text}, max(1, instr(lower(${text}), lower(${query})) - 80), ${EXCERPT_CHARS * 2})`,
    })
    .from(schema.captures)
    .where(and(captureScope(userId, filter), or(contains(schema.captures.title, q), contains(text, q))))
    .orderBy(desc(schema.captures.createdAt))
    .limit(limit);
  return rows.map((c) => ({ ...captureItem(c, filter.projects, c.text), score: 1 }));
}

async function folderName(db: Db, userId: string, folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const row = (
    await db
      .select({ name: schema.folders.name })
      .from(schema.folders)
      .where(and(eq(schema.folders.id, folderId), eq(schema.folders.userId, userId)))
      .limit(1)
  )[0];
  return row?.name ?? null;
}

async function getMeeting(_env: Env, db: Db, userId: string, id: string, args: Record<string, unknown>) {
  const m = (
    await db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.id, id), eq(schema.meetings.userId, userId), isNull(schema.meetings.deletedAt), visibleMeeting()))
      .limit(1)
  )[0];
  if (!m) return null;
  const [summary, segments, notes, project] = await Promise.all([
    db.select().from(schema.summaries).where(eq(schema.summaries.meetingId, id)).limit(1).then((rows) => rows[0]),
    db
      .select()
      .from(schema.transcriptSegments)
      .where(eq(schema.transcriptSegments.meetingId, id))
      .orderBy(schema.transcriptSegments.startMs),
    db
      .select({ contentMd: schema.userNotes.contentMd })
      .from(schema.userNotes)
      .where(eq(schema.userNotes.meetingId, id))
      .limit(1)
      .then((rows) => rows[0]?.contentMd),
    folderName(db, userId, m.folderId),
  ]);
  const names = parseSpeakerNames(m.speakerNamesJson);
  return {
    kind: 'meeting' as const,
    id: m.id,
    title: m.title,
    description: m.description,
    started_at: iso(m.startedAt),
    duration_sec: m.durationSec,
    summary: m.summaryOverrideMd ?? (summary
      ? {
          tldr: summary.tldr,
          decisions: JSON.parse(summary.decisionsJson),
          action_items: JSON.parse(summary.actionItemsJson),
          follow_ups: JSON.parse(summary.followUpsJson),
          open_questions: JSON.parse(summary.openQuestionsJson),
          topics: JSON.parse(summary.topicsJson),
          mentions: JSON.parse(summary.mentionsJson),
        }
      : null),
    /** What the user wrote about the recording themselves. */
    notes: notes?.trim() ? notes : null,
    project,
    transcript_kind: m.transcriptKind ?? null,
    transcript:
      m.transcriptOverrideMd ??
      (args.transcript_format !== 'raw' && m.agentTranscriptMd ? m.agentTranscriptMd : null) ??
      segments
        .map((s) => `[${clock(s.startMs)}] ${s.speakerId ? speakerName(s.speakerId, names) : 'Speaker'}: ${s.text}`)
        .join('\n'),
    url: meetingUrl(m.id),
  };
}

async function getDictation(_env: Env, db: Db, userId: string, id: string, _args: Record<string, unknown>) {
  const d = (
    await db
      .select()
      .from(schema.dictations)
      .where(and(eq(schema.dictations.id, id), eq(schema.dictations.userId, userId), isNull(schema.dictations.deletedAt)))
      .limit(1)
  )[0];
  if (!d) return null;
  return {
    kind: 'dictation' as const,
    id: d.id,
    title: d.title,
    text: d.cleanedText ?? d.transcript,
    transcript: d.transcript,
    cleaned: d.cleanedText,
    target_app: d.targetApp,
    created_at: iso(d.createdAt),
    duration_sec: d.durationSec,
  };
}

async function getCapture(env: Env, db: Db, userId: string, id: string, _args: Record<string, unknown>) {
  const c = (
    await db
      .select()
      .from(schema.captures)
      .where(and(eq(schema.captures.id, id), eq(schema.captures.userId, userId), isNull(schema.captures.deletedAt)))
      .limit(1)
  )[0];
  if (!c) return null;
  let text = c.transcript;
  // Notes uploaded before their text was kept on the row are read from R2.
  if (text === null && c.kind === 'note') {
    const object = await env.AUDIO_BUCKET.get(c.r2Key);
    text = object ? await object.text() : null;
  }
  const attach = c.kind === 'image' && c.bytes <= IMAGE_ATTACH_MAX_BYTES && ATTACHABLE_IMAGE_TYPES.includes(c.contentType);
  const image = attach ? await env.AUDIO_BUCKET.get(c.r2Key) : null;
  const { excerpt: _excerpt, ...listing } = captureItem({ ...c, text: null }, [], null);
  const value = {
    ...listing,
    project: await folderName(db, userId, c.folderId),
    capture_mode: c.captureMode,
    source: c.source,
    content_type: c.contentType,
    bytes: c.bytes,
    width: c.width,
    height: c.height,
    /** A note's Markdown, text read from a screenshot or image, or a video or audio transcript. */
    text,
    text_status: c.transcriptStatus,
    image_attached: image !== null,
  };
  if (!image) return value;
  return new ToolOutput(value, [{ type: 'image', data: base64(new Uint8Array(await image.arrayBuffer())), mimeType: c.contentType }]);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface ActionItemResult {
  text: string;
  owner?: string;
  due?: string;
  completed: boolean;
  meeting_id: string;
  meeting_title: string;
}

function parseActionItems(json: string): { text: string; owner?: string; due?: string; completed: boolean }[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    text: typeof item.text === 'string' ? item.text : '',
    owner: typeof item.owner === 'string' ? item.owner : undefined,
    due: typeof item.due === 'string' ? item.due : undefined,
    completed: item.completed === true,
  }));
}

function asMetadata(value: unknown): { sourceType?: string; sourceId?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    sourceType: typeof record.sourceType === 'string' ? record.sourceType : undefined,
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
  };
}
