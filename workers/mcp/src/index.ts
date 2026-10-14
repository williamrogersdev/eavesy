import { drizzle } from 'drizzle-orm/d1';
import { and, desc, eq, inArray, isNull, like, or } from 'drizzle-orm';
import type { Ai, D1Database, DurableObjectNamespace, KVNamespace, R2Bucket, VectorizeIndex } from '@cloudflare/workers-types';

import * as schema from '../../../web/src/db/schema';
import { embedTexts } from '../../../web/src/lib/ai/embed';
import { createTextDrop, DropTooLargeError } from '../../../web/src/server/create-drop';
import { MAX_TEXT_BYTES } from '../../../web/src/server/drops';
import { guardUserQuota } from '../../../web/src/server/rate-limit';
import { captureMessage, sentryOptions, withSentry } from '../../../web/src/server/observability';

interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  // Drops: shared web helpers reach these through `cloudflare:workers` env.
  AUDIO_BUCKET: R2Bucket;
  CACHE: KVNamespace;
  DROPS_HUB: DurableObjectNamespace;
  SENTRY_DSN?: string;
}

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

async function resolveToken(env: Env, rawToken: string) {
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
  if (!row.lastUsedAt || now - row.lastUsedAt > LAST_USED_RESOLUTION_MS) {
    await db.update(schema.mcpTokens).set({ lastUsedAt: now }).where(eq(schema.mcpTokens.id, row.id));
  }
  return row;
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.split('/').filter(Boolean);
    const authorization = request.headers.get('authorization') ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const rawToken = bearer || path[0];
    if (!rawToken) {
      return new Response('Eavesy MCP server', { status: 200 });
    }
    const token = await resolveToken(env, rawToken);
    if (!token) {
      return new Response(JSON.stringify({ error: 'invalid token' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    const userId = token.userId;
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
          tools: TOOL_DEFS,
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
          'Search and retrieve the authenticated user\'s Eavesy meetings, dictations, and action items, ' +
          'and send text (such as a session handoff doc) to their other devices with send_to_my_devices.',
      });
    }
    if (body.method === 'notifications/initialized') {
      return new Response(null, { status: 202 });
    }
    if (body.method === 'ping') {
      return jsonRpc(body.id, {});
    }
    if (body.method === 'tools/list') {
      return jsonRpc(body.id, { tools: TOOL_DEFS });
    }
    if (body.method === 'tools/call') {
      const { name, arguments: args } = body.params ?? {};
      try {
        const result = await callTool(env, { userId, tokenName: token.name }, name, args ?? {});
        return jsonRpc(body.id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        captureMessage('MCP tool call failed', {
          level: 'error',
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
  },
} satisfies ExportedHandler<Env>;


export default withSentry<Env>(
  (env: Env) => sentryOptions(env, { service: 'mcp', redactPath: true }),
  worker,
);

function jsonRpc(id: unknown, result?: unknown, error?: { code: number; message: string }) {
  const body: Record<string, unknown> = { jsonrpc: '2.0', id };
  if (error) body.error = error;
  else body.result = result;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const TOOL_DEFS = [
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
  },
  {
    name: 'get_meeting',
    description: 'Get a meeting by ID including summary and full transcript.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'recent_meetings',
    description: 'List the most recent meetings.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 10 } },
    },
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
  },
  {
    name: 'send_to_my_devices',
    description:
      "Send text to the user's Eavesy Drops inbox. It appears instantly on every device where they have Eavesy open, " +
      'ready to copy. Use it to hand off long output such as a session handoff doc, a plan, or a snippet the user ' +
      'wants on another computer. Drops are kept for 7 days.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `The text to send (Markdown is fine), up to ${MAX_TEXT_BYTES / 1024 / 1024} MB.` },
        title: { type: 'string', description: 'Optional heading, added as the first line of the drop.' },
      },
      required: ['text'],
    },
  },
];

async function callTool(
  env: Env,
  caller: { userId: string; tokenName: string },
  name: string,
  args: Record<string, any>,
) {
  const { userId } = caller;
  const db = drizzle(env.DB, { schema });
  switch (name) {
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

      const queryVector = (await embedTexts(env.AI, [query]))[0];
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
          .where(and(eq(schema.meetings.id, id), eq(schema.meetings.userId, userId)))
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
        transcript:
          m.transcriptOverrideMd ??
          segments
            .map((s) => `[${formatMs(s.startMs)}] ${s.speakerId ?? 'speaker'}: ${s.text}`)
            .join('\n'),
        url: `https://eavesy.com/app/meetings/${m.id}`,
      };
    }
    case 'recent_meetings': {
      const limit = Math.min(args.limit ?? 10, 50);
      const rows = await db
        .select()
        .from(schema.meetings)
        .where(and(eq(schema.meetings.userId, userId), isNull(schema.meetings.deletedAt)))
        .orderBy(desc(schema.meetings.startedAt))
        .limit(limit);
      return rows.map((m) => ({
        id: m.id,
        title: m.title,
        started_at: new Date(m.startedAt).toISOString(),
        duration_sec: m.durationSec,
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
    case 'send_to_my_devices': {
      const body = typeof args.text === 'string' ? args.text : '';
      if (!body.trim()) throw new Error('text is required');
      const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
      const text = title ? `# ${title}\n\n${body}` : body;

      const overQuota = await guardUserQuota(userId, 'drop');
      if (overQuota) throw new Error('daily drop limit reached; it resets at midnight UTC');
      try {
        const drop = await createTextDrop(db, {
          userId,
          text,
          deviceLabel: `${caller.tokenName} (MCP)`.slice(0, 60),
          origin: null,
        });
        return { id: drop.id, bytes: drop.bytes };
      } catch (error) {
        if (error instanceof DropTooLargeError) {
          throw new Error(`text too large: the limit is ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
        }
        throw error;
      }
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
