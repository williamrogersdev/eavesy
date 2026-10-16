// `eavesy mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0) over the
// local Recordings folder. Read-only; no SDK, so the binary stays small.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import { getCapture, isKind, KINDS, recent, search, type Capture } from './store';
import { VERSION } from './version';

const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
/** Images larger than this are listed by path instead of inlined. */
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
/** Total inlined per get_capture call; the rest are listed by path only. */
const MAX_INLINE_TOTAL_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const kindSchema = { type: 'string', enum: [...KINDS], description: 'Only captures of this kind.' };
const limitSchema = { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum results (default 20).' };

export const TOOLS = [
  {
    name: 'search_captures',
    description:
      'Search Eavesy captures stored on this Mac (meetings, clipboard notes, pasted images, screenshots, dropped files), including ones that never upload. Every query word must appear in the title or a text file.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words to look for.' }, kind: kindSchema, limit: limitSchema },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_capture',
    description:
      'Read one local Eavesy capture by id: metadata, its Markdown files (summary, transcript, notes, note) and, for screenshots and images, the image itself.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Capture id from search_captures or recent_captures, or the folder name.' },
        include_images: { type: 'boolean', description: 'Attach image files (default true).' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'recent_captures',
    description: 'List the most recent local Eavesy captures, newest first.',
    inputSchema: { type: 'object', properties: { kind: kindSchema, limit: limitSchema } },
    annotations: { readOnlyHint: true },
  },
] as const;

type JsonRpcId = string | number | null;
interface Request {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: Record<string, unknown>;
}
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export function summarize(capture: Capture) {
  return {
    id: capture.id,
    kind: capture.kind,
    title: capture.title,
    date: capture.date,
    source: capture.source,
    status: capture.status,
    durationSeconds: capture.durationSeconds,
    folder: capture.folder,
    files: capture.files.map((f) => f.name),
  };
}

class ToolError extends Error {}

function kindArg(value: unknown) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isKind(value)) throw new ToolError(`kind must be one of: ${KINDS.join(', ')}`);
  return value;
}

function limitArg(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new ToolError('limit must be a number');
  return value;
}

export function callTool(root: string, name: string, args: Record<string, unknown>): Content[] {
  switch (name) {
    case 'search_captures': {
      if (typeof args.query !== 'string' || !args.query.trim()) throw new ToolError('query is required');
      const hits = search(root, args.query, { kind: kindArg(args.kind), limit: limitArg(args.limit) });
      const results = hits.map((h) => ({ ...summarize(h.capture), matchedIn: h.matchedIn, snippet: h.snippet }));
      return [{ type: 'text', text: JSON.stringify({ root, results }, null, 2) }];
    }
    case 'recent_captures': {
      const results = recent(root, { kind: kindArg(args.kind), limit: limitArg(args.limit) }).map(summarize);
      return [{ type: 'text', text: JSON.stringify({ root, results }, null, 2) }];
    }
    case 'get_capture': {
      if (typeof args.id !== 'string' || !args.id.trim()) throw new ToolError('id is required');
      const capture = getCapture(root, args.id);
      if (!capture) throw new ToolError(`no capture with id ${args.id} in ${root}`);
      const content: Content[] = [
        {
          type: 'text',
          text: JSON.stringify(
            { ...summarize(capture), files: capture.files.map(({ name, path, role, bytes }) => ({ name, path, role, bytes })), text: capture.text },
            null,
            2,
          ),
        },
      ];
      if (args.include_images !== false) {
        let budget = MAX_INLINE_TOTAL_BYTES;
        for (const file of capture.files) {
          const mimeType = IMAGE_TYPES[extname(file.name).toLowerCase()];
          if (!mimeType || file.bytes > MAX_INLINE_IMAGE_BYTES || file.bytes > budget) continue;
          try {
            const data = readFileSync(file.path);
            budget -= data.byteLength;
            content.push({ type: 'image', data: data.toString('base64'), mimeType });
          } catch {
            // Listed above by path; skip what cannot be read.
          }
        }
      }
      return content;
    }
    default:
      throw new ToolError(`unknown tool: ${name}`);
  }
}

/** Handles one JSON-RPC message; returns the response, or null for notifications. */
export function handleMessage(root: string, message: unknown): object | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } };
  }
  const req = message as Request;
  const isNotification = !('id' in req) || req.id === undefined;
  const id = req.id ?? null;
  const ok = (result: object) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, msg: string) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });

  if (isNotification) return null;
  switch (req.method) {
    case 'initialize': {
      const requested = req.params?.protocolVersion;
      const protocolVersion = (MCP_VERSIONS as readonly unknown[]).includes(requested) ? requested : MCP_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'eavesy-local', version: VERSION },
        instructions: `Read-only access to Eavesy captures on this Mac (${root}): meetings, clipboard notes, pasted images and screenshots, including ones that never upload. Use recent_captures or search_captures, then get_capture.`,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = req.params?.name;
      const args = req.params?.arguments ?? {};
      if (typeof name !== 'string') return fail(-32602, 'missing tool name');
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `unknown tool: ${name}`);
      if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail(-32602, 'arguments must be an object');
      try {
        return ok({ content: callTool(root, name, args as Record<string, unknown>) });
      } catch (error) {
        // Tool failures are results the model can read, not protocol errors.
        const text = error instanceof ToolError ? error.message : `internal error: ${error instanceof Error ? error.message : String(error)}`;
        return ok({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}

export function serveStdio(root: string): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      return;
    }
    const response = handleMessage(root, message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve) => lines.on('close', resolve));
}
