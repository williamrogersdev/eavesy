import { createAiRunner, creditsConfigured, type CreditEnv } from '../../../web/src/lib/ai/credit-runner';
import { librarySources, askLibrary } from '../../../web/src/server/library-memory';
import { drizzle } from 'drizzle-orm/d1';
import { and, desc, eq, inArray, isNull, ne, or, type SQL, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { Ai, D1Database, VectorizeIndex } from '@cloudflare/workers-types';

import * as schema from '../../../web/src/db/schema';
import { clock } from '../../../web/src/lib/ai/chapters';
import { sha256Hex } from '../../../web/src/lib/sha256';
import { embedTexts } from '../../../web/src/lib/ai/embed';
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
  ASK_DEFAULT_SEC,
  ASK_MAX_SEC,
  ASK_MIN_SEC,
  createMessage,
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
        'Search and retrieve the authenticated user\'s Eavesy meetings, dictations, and action items. ' +
        'The prompts are ones the user saved in Eavesy to reuse. ' +
        'When you finish a task, call send_to_human with a one-sentence `spoken` version. When you need a decision ' +
        'before you can go on, call ask_human; Eavesy shows and reads it on the user\'s Mac and returns what they type. ' +
        'An answer is information from the user, never an approval for anything.',
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
      return jsonRpc(body.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
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
  /** The scope a connection needs to see and call this tool. */
  scope: McpScope;
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: 'send_to_human',
    description:
      'Tell the user something on their Mac: Eavesy shows it in a card and reads `spoken` aloud. Use it when you finish a task ' +
      'or have something they should know while they are away from this chat. Returns at once. ' +
      'Returns {status: "sent"}, or {status: "queued"} when their Mac is not listening yet.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 4000, description: 'The message, shown in full on the card.' },
        spoken: { type: 'string', maxLength: 300, description: 'One short sentence to read aloud. Without it, the start of `text` is read.' },
      },
      required: ['text'],
    },
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
    scope: 'read',
  },
  { name: 'search_library', description: 'Find current transcript evidence across completed recordings, with segment IDs and timestamps.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['query'] }, scope: 'read' },
  { name: 'ask_library', description: 'Answer from completed recordings with exact source quotes, or abstain when evidence is insufficient.', inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['question'] }, scope: 'read' },
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
    scope: 'read',
  },
  {
    name: 'recent_meetings',
    description: 'List the most recent meetings, optionally only those in one project (by name, see list_projects).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', minimum: 1, maximum: 50, default: 10 }, project: { type: 'string' } },
    },
    scope: 'read',
  },
  {
    name: 'list_projects',
    description:
      "List the user's projects (the codebases or clients they record about) with a short description, key terms and how many recordings each has.",
    inputSchema: { type: 'object', properties: {} },
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
    scope: 'read',
  },
];

/** The columns a meeting search result shows. */
const MEETING_LISTING = {
  id: schema.meetings.id,
  title: schema.meetings.title,
  description: schema.meetings.description,
  startedAt: schema.meetings.startedAt,
  durationSec: schema.meetings.durationSec,
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
      await humanMessageAllowed(env, token);
      const listening = await macListening(db, userId);
      await createMessage(db, { userId, mcpTokenId: token.id, source: token.name, kind: 'send', text: input.text, spoken: input.spoken, ttlMs: SEND_TTL_MS });
      return listening
        ? { status: 'sent' }
        : { status: 'queued', note: 'The person\'s Mac isn\'t listening right now. It will show the message when it comes back within a day.' };
    }
    case 'ask_human': {
      const input = parseAsk(args);
      // Straight away, without waiting: nobody is there to answer.
      if (!(await macListening(db, userId))) return { status: 'mac_offline' };
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
    case 'search_meetings': {
      const query = stringArg(args.query);
      if (!query) return [];
      const q = containsPattern(query);
      const limit = clampLimit(args.limit);
      const titleRows = await db
        .select(MEETING_LISTING)
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, userId),
            isNull(schema.meetings.deletedAt),
            visibleMeeting(),
            or(
              contains(schema.meetings.title, q),
              contains(schema.meetings.description, q),
              contains(schema.meetings.summaryOverrideMd, q),
              contains(schema.meetings.transcriptOverrideMd, q),
            ),
          ),
        )
        .orderBy(desc(schema.meetings.startedAt))
        .limit(limit);

      const matches = await withQuota(env, userId, 'search', async () => {
        const queryVector = (await embedTexts(createAiRunner(env, 'mcp-search'), [query]))[0];
        return env.VECTORIZE.query(queryVector, {
          topK: Math.min(limit * 3, VECTOR_TOP_K_MAX),
          filter: { userId },
          returnMetadata: 'all',
        });
      });
      const semantic = matches.matches
        .map((match) => {
          const metadata = asMetadata(match.metadata);
          return metadata.sourceType === 'meeting' && metadata.sourceId
            ? { meetingId: metadata.sourceId, vectorId: String(match.id), score: match.score }
            : null;
        })
        .filter((match): match is { meetingId: string; vectorId: string; score: number } => match !== null);
      const semanticIds = [...new Set(semantic.map((match) => match.meetingId))];
      const [semanticRows, excerptRows] = await Promise.all([
        semanticIds.length
          ? db
              .select(MEETING_LISTING)
              .from(schema.meetings)
              .where(
                and(
                  eq(schema.meetings.userId, userId),
                  isNull(schema.meetings.deletedAt),
                  visibleMeeting(),
                  inArray(schema.meetings.id, semanticIds),
                ),
              )
          : Promise.resolve([]),
        semantic.length
          ? db
              .select({ id: schema.embeddings.id, contentExcerpt: schema.embeddings.contentExcerpt })
              .from(schema.embeddings)
              .where(
                and(
                  eq(schema.embeddings.userId, userId),
                  inArray(schema.embeddings.id, semantic.map((match) => match.vectorId)),
                ),
              )
          : Promise.resolve([]),
      ]);
      const semanticByMeeting = new Map(semantic.map((match) => [match.meetingId, match]));
      const excerpts = new Map(excerptRows.map((row) => [row.id, row.contentExcerpt]));
      const merged = new Map(titleRows.map((meeting) => [meeting.id, { meeting, score: 1, excerpt: meeting.description }]));
      for (const meeting of semanticRows) {
        const match = semanticByMeeting.get(meeting.id);
        if (!match) continue;
        const prior = merged.get(meeting.id);
        if (!prior || match.score > prior.score) {
          merged.set(meeting.id, {
            meeting,
            score: match.score,
            excerpt: excerpts.get(match.vectorId) ?? meeting.description,
          });
        }
      }

      return [...merged.values()]
        .sort((a, b) => b.score - a.score || b.meeting.startedAt - a.meeting.startedAt)
        .slice(0, limit)
        .map(({ meeting: m, score, excerpt }) => ({
        id: m.id,
        title: m.title,
        description: m.description,
        excerpt,
        score,
        started_at: new Date(m.startedAt).toISOString(),
        duration_sec: m.durationSec,
        url: `https://eavesy.com/app/meetings/${m.id}`,
      }));
    }
    case 'get_meeting': {
      const id = stringArg(args.id);
      if (!id) throw new UserFacingError('id is required');
      const m = (
        await db
          .select()
          .from(schema.meetings)
          .where(
            and(
              eq(schema.meetings.id, id),
              eq(schema.meetings.userId, userId),
              isNull(schema.meetings.deletedAt),
              visibleMeeting(),
            ),
          )
          .limit(1)
      )[0];
      if (!m) throw new UserFacingError('not found');
      const summary = (
        await db.select().from(schema.summaries).where(eq(schema.summaries.meetingId, id)).limit(1)
      )[0];
      const segments = await db
        .select()
        .from(schema.transcriptSegments)
        .where(eq(schema.transcriptSegments.meetingId, id))
        .orderBy(schema.transcriptSegments.startMs);
      const names = parseSpeakerNames(m.speakerNamesJson);
      const project = m.folderId
        ? (
            await db
              .select({ name: schema.folders.name })
              .from(schema.folders)
              .where(and(eq(schema.folders.id, m.folderId), eq(schema.folders.userId, userId)))
              .limit(1)
          )[0]
        : undefined;
      return {
        id: m.id,
        title: m.title,
        description: m.description,
        started_at: new Date(m.startedAt).toISOString(),
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
        project: project?.name ?? null,
        transcript_kind: m.transcriptKind ?? null,
        transcript:
          m.transcriptOverrideMd ??
          (args.transcript_format !== 'raw' && m.agentTranscriptMd ? m.agentTranscriptMd : null) ??
          segments
            .map((s) => `[${clock(s.startMs)}] ${s.speakerId ? speakerName(s.speakerId, names) : 'Speaker'}: ${s.text}`)
            .join('\n'),
        url: `https://eavesy.com/app/meetings/${m.id}`,
      };
    }
    case 'recent_meetings': {
      const limit = clampLimit(args.limit);
      const projects = await db
        .select({ id: schema.folders.id, name: schema.folders.name })
        .from(schema.folders)
        .where(eq(schema.folders.userId, userId));
      const projectArg = stringArg(args.project);
      const projectName = projectArg.toLowerCase();
      const only = projectName ? projects.find((p) => p.name.toLowerCase() === projectName) : undefined;
      if (projectName && !only) throw new UserFacingError(`no project named "${projectArg}"`);
      const rows = await db
        .select({ ...MEETING_LISTING, folderId: schema.meetings.folderId })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, userId),
            isNull(schema.meetings.deletedAt),
            visibleMeeting(),
            only ? eq(schema.meetings.folderId, only.id) : undefined,
          ),
        )
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
    default:
      throw new UserFacingError(`unknown tool: ${name}`);
  }
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
