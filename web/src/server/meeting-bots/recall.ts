/**
 * Recall.ai, the managed meeting-bot provider for the notetaker pilot.
 * https://docs.recall.ai — every call here is scoped to one bot we created.
 */

export interface RecallEnv {
  RECALL_API_KEY?: string;
  RECALL_WEBHOOK_SECRET?: string;
  /** Recall region subdomain; the API key belongs to exactly one region. */
  RECALL_REGION?: string;
}

/** Thrown for any provider failure. `uncertain` means the request may have taken effect. */
export class RecallError extends Error {
  constructor(message: string, readonly status: number | null, readonly uncertain: boolean) {
    super(message);
  }
}

/** Recall needs this much notice to schedule a bot; anything sooner joins right away. */
export const SCHEDULE_NOTICE_MS = 10 * 60 * 1_000;
const TIMEOUT_MS = 15_000;
/** Signed deliveries older or newer than this are refused as replays. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1_000;

export function recallConfigured(env: RecallEnv): env is RecallEnv & { RECALL_API_KEY: string; RECALL_WEBHOOK_SECRET: string } {
  return Boolean(env.RECALL_API_KEY && env.RECALL_WEBHOOK_SECRET);
}

function baseUrl(env: RecallEnv) {
  const region = env.RECALL_REGION || 'us-west-2';
  if (!/^[a-z0-9-]+$/.test(region)) throw new RecallError('Invalid RECALL_REGION', null, false);
  return `https://${region}.recall.ai/api/v1`;
}

async function call(env: RecallEnv, method: string, path: string, body?: unknown): Promise<unknown> {
  if (!env.RECALL_API_KEY) throw new RecallError('Recall.ai is not configured', null, false);
  let response: Response;
  try {
    response = await fetch(`${baseUrl(env)}${path}`, {
      method,
      headers: {
        authorization: `Token ${env.RECALL_API_KEY}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A timeout or dropped connection can still have reached Recall.
    throw new RecallError(`Recall.ai request failed: ${error instanceof Error ? error.message : String(error)}`, null, method !== 'GET');
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new RecallError(`Recall.ai ${method} ${path.split('/')[1]} returned ${response.status}: ${detail}`, response.status, response.status >= 500 && method !== 'GET');
  }
  if (response.status === 204) return null;
  const text = await response.text();
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // Recall answered 2xx, so a write may well have taken effect.
    throw new RecallError(`Recall.ai ${method} ${path.split('/')[1]} returned unreadable JSON`, response.status, method !== 'GET');
  }
}

export interface CreateBotInput {
  meetingUrl: string;
  /** Epoch ms; omitted or too soon to schedule means join now. */
  joinAt?: number | null;
  botName: string;
  /** Our row id, echoed back on every webhook for this bot. */
  eavesyBotId: string;
  now?: number;
}

export function createBotBody(input: CreateBotInput) {
  const now = input.now ?? Date.now();
  const scheduled = input.joinAt && input.joinAt - now >= SCHEDULE_NOTICE_MS;
  return {
    meeting_url: input.meetingUrl,
    bot_name: input.botName,
    ...(scheduled ? { join_at: new Date(input.joinAt!).toISOString() } : {}),
    metadata: { eavesy_bot_id: input.eavesyBotId },
    recording_config: {
      transcript: {
        provider: { recallai_streaming: { mode: 'prioritize_accuracy', language_code: 'auto' } },
        diarization: { use_separate_streams_when_available: true },
      },
      audio_mixed_mp3: {},
      // Audio is all Eavesy keeps; don't have the provider record video at all.
      video_mixed_mp4: null,
    },
  };
}

export async function createBot(env: RecallEnv, input: CreateBotInput): Promise<{ id: string }> {
  const result = await call(env, 'POST', '/bot/', createBotBody(input));
  const id = (result as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new RecallError('Recall.ai returned no bot id', null, true);
  return { id };
}

export interface MediaShortcut {
  status: string | null;
  downloadUrl: string | null;
}

export interface RecallBot {
  id: string;
  /** Newest status change, as the webhooks report it. */
  latest: { code: string; subCode: string | null; at: number } | null;
  recording: {
    id: string;
    startedAt: number | null;
    completedAt: number | null;
    transcript: MediaShortcut;
    audio: MediaShortcut;
  } | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function time(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function shortcut(value: unknown): MediaShortcut {
  const item = record(value);
  return { status: str(record(item.status).code), downloadUrl: str(record(item.data).download_url) };
}

export function parseBot(raw: unknown): RecallBot {
  const bot = record(raw);
  const changes = Array.isArray(bot.status_changes) ? bot.status_changes.map(record) : [];
  const last = changes.at(-1);
  const recordings = Array.isArray(bot.recordings) ? bot.recordings.map(record) : [];
  // A bot that rejoined has one recording per stint; the first holds the meeting.
  const first = recordings[0];
  const shortcuts = record(first?.media_shortcuts);
  return {
    id: str(bot.id) ?? '',
    latest: last && str(last.code)
      ? { code: str(last.code)!, subCode: str(last.sub_code), at: time(last.created_at) ?? Date.now() }
      : null,
    recording: first && str(first.id)
      ? {
          id: str(first.id)!,
          startedAt: time(first.started_at),
          completedAt: time(first.completed_at),
          transcript: shortcut(shortcuts.transcript),
          audio: shortcut(shortcuts.audio_mixed),
        }
      : null,
  };
}

export async function getBot(env: RecallEnv, id: string): Promise<RecallBot> {
  return parseBot(await call(env, 'GET', `/bot/${encodeURIComponent(id)}/`));
}

/** Cancels a bot that hasn't joined yet, or makes one in a call leave. */
export async function removeBot(env: RecallEnv, id: string, inCall: boolean) {
  const bot = encodeURIComponent(id);
  if (inCall) await call(env, 'POST', `/bot/${bot}/leave_call/`);
  else await call(env, 'DELETE', `/bot/${bot}/`);
}

/** Drops the provider's copy of the recording once Eavesy holds its own. */
export async function deleteBotMedia(env: RecallEnv, id: string) {
  await call(env, 'POST', `/bot/${encodeURIComponent(id)}/delete_media/`);
}

export async function download(url: string): Promise<Response> {
  // Download URLs are pre-signed and must not carry the API key.
  const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60 * 1_000) });
  if (!response.ok) throw new RecallError(`Recall.ai download returned ${response.status}`, response.status, false);
  return response;
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Verifies a Recall webhook (Svix scheme: HMAC-SHA256 over `id.timestamp.body`).
 * Accounts from before December 2025 send `svix-*` headers, newer ones
 * `webhook-*`. Returns the delivery id, or null when the request isn't Recall's.
 */
export async function verifyWebhook(secret: string, headers: Headers, body: string, now = Date.now()): Promise<string | null> {
  const id = headers.get('webhook-id') ?? headers.get('svix-id');
  const timestamp = headers.get('webhook-timestamp') ?? headers.get('svix-timestamp');
  const signatures = headers.get('webhook-signature') ?? headers.get('svix-signature');
  if (!id || !timestamp || !signatures || !secret.startsWith('whsec_')) return null;
  const sentAt = Number(timestamp) * 1_000;
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_MS) return null;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey('raw', base64ToBytes(secret.slice('whsec_'.length)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  } catch {
    return null;
  }
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  for (const versioned of signatures.split(' ')) {
    const [version, signature] = versioned.split(',');
    if (version !== 'v1' || !signature) continue;
    try {
      if (equalBytes(base64ToBytes(signature), expected)) return id;
    } catch {
      /* malformed signature: try the next one */
    }
  }
  return null;
}
