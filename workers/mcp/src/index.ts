import { createAiRunner, creditsConfigured, type CreditEnv } from '../../../web/src/lib/ai/credit-runner';
import { librarySources, askLibrary } from '../../../web/src/server/library-memory';
import { drizzle } from 'drizzle-orm/d1';
import { and, desc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import type { Ai, D1Database, VectorizeIndex } from '@cloudflare/workers-types';

import * as schema from '../../../web/src/db/schema';
import { embedTexts } from '../../../web/src/lib/ai/embed';
import { parseStringList } from '../../../web/src/lib/projects';
import { parseSpeakerNames, speakerName } from '../../../web/src/lib/transcription/two-track';
import { captureMessage, withErrorReporting } from '../../../web/src/server/observability';
import { consumeRateLimit } from '../../../web/src/server/rate-limit-store';
import {
  mcpTokenExpiresAt,
  pathTokensAllowed,
  renewedMcpTokenExpiry,
} from '../../../web/src/server/mcp-token-policy';
import { type McpScope, parseMcpScopes, toolsForScopes } from '../../../web/src/server/mcp-scopes';
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

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;
const MCP_REQUESTS_PER_MINUTE = 120;
const CLIENT_REGISTRATIONS_PER_HOUR = 20;

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
    // Per token, after the token is known to be valid, failing open: the server
    // is read-only, every call is already authenticated, and an unreachable
    // counter means D1 is down anyway.
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
    const response = await serve(request, env, token.userId, parseMcpScopes(token.scopesJson));
    if (viaPath) response.headers.set('deprecation', 'true');
    return response;
  },
} satisfies ExportedHandler<Env>;

async function serve(request: Request, env: Env, userId: string, scopes: McpScope[]): Promise<Response> {
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

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400 });
  }

  if (body.method === 'initialize') {
    const requested = body.params?.protocolVersion;
    const protocolVersion = MCP_VERSIONS.includes(requested) ? requested : MCP_VERSIONS[0];
    return jsonRpc(body.id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'eavesy', version: '0.1.0' },
      instructions:
        'Search and retrieve the authenticated user\'s Eavesy meetings, dictations, and action items.',
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
  if (body.method === 'tools/call') {
    const { name, arguments: args } = body.params ?? {};
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
      const result = await callTool(env, userId, name, args ?? {});
      return jsonRpc(body.id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      captureMessage('MCP tool call failed', {
        tags: { mcp_tool: typeof name === 'string' ? name : 'unknown' },
      });
      return jsonRpc(body.id, undefined, {
        code: -32000,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonRpc(body.id, undefined, {
    code: -32601,
    message: `method not supported: ${body.method}`,
  });
}


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

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The scope a connection needs to see and call this tool. */
  scope: McpScope;
}

const TOOL_DEFS: ToolDef[] = [
  { name: 'search_library', description: 'Find current transcript evidence across completed recordings, with segment IDs and timestamps.', inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['query'] }, scope: 'read' },
  { name: 'ask_library', description: 'Answer from completed recordings with exact source quotes, or abstain when evidence is insufficient.', inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 3, maxLength: 1000 } }, required: ['question'] }, scope: 'read' },
  {
    name: 'search_meetings',
    description: "Search the user's meetings by title or transcript content. Returns matching meetings with an excerpt.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', default: 10 },
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
      properties: { limit: { type: 'number', default: 10 }, project: { type: 'string' } },
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
        limit: { type: 'number', default: 10 },
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

async function callTool(env: Env, userId: string, name: string, args: Record<string, any>) {
  const db = drizzle(env.DB, { schema });
  switch (name) {
    case 'search_library':
    case 'ask_library': {
      const question = String(name === 'ask_library' ? args.question ?? '' : args.query ?? '').trim();
      if (question.length < 3 || question.length > 1000) throw new Error('Question must be between 3 and 1000 characters');
      if (name === 'ask_library' && !creditsConfigured(env)) throw new Error('Library answers are not enabled');
      const opts = { ai: createAiRunner(env, 'mcp-library'), vectorize: env.VECTORIZE };
      return name === 'ask_library' ? askLibrary(db, userId, question, opts) : librarySources(db, userId, question, opts);
    }
    case 'search_meetings': {
      const query = String(args.query ?? '').trim();
      if (!query) return [];
      const q = `%${query.replace(/%/g, '\\%')}%`;
      const limit = Math.min(args.limit ?? 10, 50);
      const titleRows = await db
        .select()
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, userId),
            isNull(schema.meetings.deletedAt),
              or(ne(schema.meetings.source, 'import'), eq(schema.meetings.status, 'complete')),
            or(
              like(schema.meetings.title, q),
              like(schema.meetings.description, q),
              like(schema.meetings.summaryOverrideMd, q),
              like(schema.meetings.transcriptOverrideMd, q),
            ),
          ),
        )
        .orderBy(desc(schema.meetings.startedAt))
        .limit(limit);

      const queryVector = (await embedTexts(createAiRunner(env, 'mcp-search'), [query]))[0];
      const matches = await env.VECTORIZE.query(queryVector, {
        topK: limit * 3,
        filter: { userId },
        returnMetadata: 'all',
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
              .select()
              .from(schema.meetings)
              .where(
                and(
                  eq(schema.meetings.userId, userId),
                  isNull(schema.meetings.deletedAt),
              or(ne(schema.meetings.source, 'import'), eq(schema.meetings.status, 'complete')),
                  inArray(schema.meetings.id, semanticIds),
                ),
              )
          : Promise.resolve([]),
        semantic.length
          ? db
              .select()
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
      const id = String(args.id ?? '');
      const m = (
        await db
          .select()
          .from(schema.meetings)
          .where(
            and(
              eq(schema.meetings.id, id),
              eq(schema.meetings.userId, userId),
              isNull(schema.meetings.deletedAt),
            ),
          )
          .limit(1)
      )[0];
      if (!m) throw new Error('not found');
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
            .map((s) => `[${formatMs(s.startMs)}] ${s.speakerId ? speakerName(s.speakerId, names) : 'Speaker'}: ${s.text}`)
            .join('\n'),
        url: `https://eavesy.com/app/meetings/${m.id}`,
      };
    }
    case 'recent_meetings': {
      const limit = Math.min(args.limit ?? 10, 50);
      const projects = await db
        .select({ id: schema.folders.id, name: schema.folders.name })
        .from(schema.folders)
        .where(eq(schema.folders.userId, userId));
      const projectName = typeof args.project === 'string' ? args.project.trim().toLowerCase() : '';
      const only = projectName ? projects.find((p) => p.name.toLowerCase() === projectName) : undefined;
      if (projectName && !only) throw new Error(`no project named "${args.project}"`);
      const rows = await db
        .select()
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.userId, userId),
            isNull(schema.meetings.deletedAt),
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
      const q = `%${(args.query ?? '').replace(/%/g, '\\%')}%`;
      const limit = Math.min(args.limit ?? 10, 50);
      const rows = await db
        .select()
        .from(schema.dictations)
        .where(
          and(
            eq(schema.dictations.userId, userId),
            isNull(schema.dictations.deletedAt),
            or(like(schema.dictations.transcript, q), like(schema.dictations.title, q)),
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
      const status = (args.status ?? 'open') as 'open' | 'completed' | 'all';
      const summaries = await db
        .select({
          summary: schema.summaries,
          meeting: schema.meetings,
        })
        .from(schema.summaries)
        .innerJoin(schema.meetings, eq(schema.meetings.id, schema.summaries.meetingId))
        .where(and(eq(schema.meetings.userId, userId), isNull(schema.meetings.deletedAt)));
      const out: any[] = [];
      for (const row of summaries) {
        const items = JSON.parse(row.summary.actionItemsJson) as {
          text: string;
          owner?: string;
          due?: string;
          completed: boolean;
        }[];
        for (const a of items) {
          if (status === 'open' && a.completed) continue;
          if (status === 'completed' && !a.completed) continue;
          if (args.owner && a.owner !== args.owner) continue;
          out.push({
            text: a.text,
            owner: a.owner,
            due: a.due,
            completed: a.completed,
            meeting_id: row.meeting.id,
            meeting_title: row.meeting.title,
          });
        }
      }
      return out;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function asMetadata(value: unknown): { sourceType?: string; sourceId?: string } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  return {
    sourceType: typeof record.sourceType === 'string' ? record.sourceType : undefined,
    sourceId: typeof record.sourceId === 'string' ? record.sourceId : undefined,
  };
}

function formatMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
