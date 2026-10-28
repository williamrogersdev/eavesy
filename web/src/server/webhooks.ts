import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from '@/db/schema';
import { mcpTokens, webhookEndpoints } from '@/db/schema';
import { pid } from '@/db/ids';
import { isRecord } from '@/lib/json';
import { reportError } from '@/server/observability';
import { getCloudflareContext } from '@/server/cloudflare-context';
import { mcpTokenExpiresAt } from '@/server/mcp-token-policy';

type Db = DrizzleD1Database<typeof schema>;
type Endpoint = typeof webhookEndpoints.$inferSelect;

/** What an endpoint can subscribe to. `webhook.test` is only ever sent by a test. */
export const WEBHOOK_EVENTS = ['recording.completed', 'dictation.created', 'capture.created'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_ENDPOINTS_MAX = 10;
export const WEBHOOK_URL_MAX_CHARS = 2000;
export const WEBHOOK_DESCRIPTION_MAX_CHARS = 200;
export const WEBHOOK_TIMEOUT_MS = 15_000;
/**
 * The wait before each retry of a failed delivery: 8 attempts over about 27
 * hours. Queue delays top out at 12 hours.
 */
export const WEBHOOK_RETRY_DELAYS_SEC = [60, 300, 1_800, 7_200, 18_000, 36_000, 36_000] as const;
/** An endpoint is turned off after this many events in a row ran out of retries. */
export const WEBHOOK_DISABLE_AFTER = 5;

const APP_URL = 'https://eavesy.com';

/** The item an event is about, in the same shape the REST API lists items. */
export interface WebhookItem {
  id: string;
  kind: string;
  title: string;
  created_at: string;
  url: string | null;
}

export interface WebhookEvent {
  id: string;
  type: WebhookEventType | 'webhook.test';
  timestamp: string;
  data: WebhookItem | Record<string, unknown>;
}

/** The queue message that carries one event to one endpoint. `attempt` counts from 1. */
export interface WebhookDelivery {
  kind: 'deliver-webhook';
  endpointId: string;
  event: WebhookEvent;
  attempt: number;
}

interface QueueLike {
  send(message: WebhookDelivery, options?: { delaySeconds?: number }): Promise<unknown>;
}

export interface WebhookEnv {
  DB: D1Database;
  PROCESSING_QUEUE: QueueLike;
}

/** An error whose message is meant for the person setting up the endpoint. */
export class WebhookInputError extends Error {}

export function webhookItem(item: { id: string; kind: string; title: string; createdAt: number }): WebhookItem {
  const url = item.kind === 'meeting'
    ? `${APP_URL}/app/meetings/${item.id}`
    : item.kind === 'dictation' || item.kind === 'note'
      ? null
      : `${APP_URL}/app/captures/${item.id}`;
  return { id: item.id, kind: item.kind, title: item.title, created_at: new Date(item.createdAt).toISOString(), url };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function newWebhookSecret(): string {
  return `whsec_${base64(crypto.getRandomValues(new Uint8Array(24)))}`;
}

/** The `webhook-signature` value for a delivery: HMAC-SHA256 over `id.timestamp.body`, as Standard Webhooks signs. */
export async function signWebhook(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${base64(new Uint8Array(signature))}`;
}

/** Why Eavesy won't send to this URL, or null when it will. */
export function webhookUrlProblem(raw: string): string | null {
  if (raw.length > WEBHOOK_URL_MAX_CHARS) return `url must be at most ${WEBHOOK_URL_MAX_CHARS} characters`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url must be a full URL, like https://example.com/hooks/eavesy';
  }
  if (url.protocol !== 'https:') return 'url must start with https://';
  if (url.username || url.password) return 'url must not contain a user name or password';
  // `localhost.` and `127.0.0.1.` name the same hosts as without the dot.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // The URL parser has already turned every IPv4 spelling into dotted decimal.
  if (host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host)) return 'url must use a host name, not an IP address';
  if (!host.includes('.') || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return 'url must be a public address';
  return null;
}

function parseEvents(json: string): WebhookEventType[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? WEBHOOK_EVENTS.filter((event) => value.includes(event)) : [];
  } catch {
    return [];
  }
}

function eventsArg(value: unknown): WebhookEventType[] {
  if (!Array.isArray(value) || value.length === 0) throw new WebhookInputError(`events must list one or more of: ${WEBHOOK_EVENTS.join(', ')}`);
  const unknown: unknown = (value as unknown[]).find((event) => !WEBHOOK_EVENTS.includes(event as WebhookEventType));
  if (unknown !== undefined) throw new WebhookInputError(`unknown event ${JSON.stringify(unknown)}; events are ${WEBHOOK_EVENTS.join(', ')}`);
  return WEBHOOK_EVENTS.filter((event) => value.includes(event));
}

function urlArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new WebhookInputError('url is required');
  const url = value.trim();
  const problem = webhookUrlProblem(url);
  if (problem) throw new WebhookInputError(problem);
  return url;
}

function descriptionArg(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new WebhookInputError('description must be text');
  const description = value.trim().replace(/\s+/g, ' ');
  if (description.length > WEBHOOK_DESCRIPTION_MAX_CHARS) {
    throw new WebhookInputError(`description must be at most ${WEBHOOK_DESCRIPTION_MAX_CHARS} characters`);
  }
  return description;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** An endpoint as the API shows it. The secret is shown once, when the endpoint is made. */
export function webhookView(endpoint: Endpoint) {
  return {
    id: endpoint.id,
    url: endpoint.url,
    description: endpoint.description,
    events: parseEvents(endpoint.eventsJson),
    enabled: endpoint.disabledAt === null,
    disabled_reason: endpoint.disabledReason,
    created_at: new Date(endpoint.createdAt).toISOString(),
    last_attempt_at: iso(endpoint.lastAttemptAt),
    last_success_at: iso(endpoint.lastSuccessAt),
    last_status: endpoint.lastStatus,
    last_error: endpoint.lastError,
    created_by_key_id: endpoint.createdByTokenId,
  };
}
export type WebhookView = ReturnType<typeof webhookView>;

async function findEndpoint(db: Db, userId: string, id: string): Promise<Endpoint | undefined> {
  return (
    await db
      .select()
      .from(webhookEndpoints)
      .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)))
      .limit(1)
  )[0];
}

export async function listWebhookEndpoints(db: Db, userId: string): Promise<WebhookView[]> {
  const rows = await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.userId, userId)).orderBy(webhookEndpoints.createdAt);
  return rows.map(webhookView);
}

export async function getWebhookEndpoint(db: Db, userId: string, id: string): Promise<WebhookView | null> {
  const endpoint = await findEndpoint(db, userId, id);
  return endpoint ? webhookView(endpoint) : null;
}

/**
 * `createdByTokenId` is the API key or MCP connection adding it, if any: the
 * endpoint then sends only while that key works, so revoking a key also stops
 * what it set up.
 */
export async function createWebhookEndpoint(
  db: Db,
  userId: string,
  input: unknown,
  createdByTokenId: string | null = null,
): Promise<WebhookView & { secret: string }> {
  const body = isRecord(input) ? input : {};
  const url = urlArg(body.url);
  const events = body.events === undefined ? [...WEBHOOK_EVENTS] : eventsArg(body.events);
  const description = descriptionArg(body.description);
  const [{ total }] = await db.select({ total: count() }).from(webhookEndpoints).where(eq(webhookEndpoints.userId, userId));
  if (total >= WEBHOOK_ENDPOINTS_MAX) throw new WebhookInputError(`an account can have at most ${WEBHOOK_ENDPOINTS_MAX} webhook endpoints`);
  const now = Date.now();
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      id: pid('whk', now),
      userId,
      url,
      description,
      secret: newWebhookSecret(),
      eventsJson: JSON.stringify(events),
      createdAt: now,
      updatedAt: now,
      createdByTokenId,
    })
    .returning();
  return { ...webhookView(row), secret: row.secret };
}

/** Changes the url, events, description, or turns the endpoint on (`enabled: true`, which also clears its failures) or off. */
export async function updateWebhookEndpoint(db: Db, userId: string, id: string, input: unknown): Promise<WebhookView | null> {
  const body = isRecord(input) ? input : {};
  const changes: Partial<typeof webhookEndpoints.$inferInsert> = {};
  if (body.url !== undefined) changes.url = urlArg(body.url);
  if (body.events !== undefined) changes.eventsJson = JSON.stringify(eventsArg(body.events));
  if (body.description !== undefined) changes.description = descriptionArg(body.description);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new WebhookInputError('enabled must be true or false');
    Object.assign(
      changes,
      body.enabled
        ? { disabledAt: null, disabledReason: null, failedEvents: 0 }
        : { disabledAt: Date.now(), disabledReason: 'Turned off.' },
    );
  }
  if (Object.keys(changes).length === 0) throw new WebhookInputError('nothing to change: send url, events, description or enabled');
  const [row] = await db
    .update(webhookEndpoints)
    .set({ ...changes, updatedAt: Date.now() })
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)))
    .returning();
  return row ? webhookView(row) : null;
}

export async function deleteWebhookEndpoint(db: Db, userId: string, id: string): Promise<boolean> {
  const deleted = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.userId, userId)))
    .returning({ id: webhookEndpoints.id });
  return deleted.length > 0;
}

/** One POST of one event. Never throws: a failure comes back as `error`. */
export async function sendWebhook(endpoint: Pick<Endpoint, 'url' | 'secret'>, event: WebhookEvent, now = Date.now()) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(now / 1_000);
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Eavesy-Webhooks/1',
        'webhook-id': event.id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': await signWebhook(endpoint.secret, event.id, timestamp, body),
      },
      body,
      // A redirect could point anywhere; the receiver should give its final URL.
      redirect: 'manual',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    const ok = response.status >= 200 && response.status < 300;
    return { status: response.status, error: ok ? null : `The endpoint answered HTTP ${response.status}.` };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { status: null, error: timedOut ? `No answer within ${WEBHOOK_TIMEOUT_MS / 1_000} seconds.` : 'Could not connect to the endpoint.' };
  }
}

/** Sends a `webhook.test` event straight away, without retries, and says how it went. */
export async function testWebhookEndpoint(db: Db, userId: string, id: string) {
  const endpoint = await findEndpoint(db, userId, id);
  if (!endpoint) return null;
  const now = Date.now();
  const event: WebhookEvent = {
    id: pid('evt', now),
    type: 'webhook.test',
    timestamp: new Date(now).toISOString(),
    data: { endpoint_id: endpoint.id, message: 'A test event from Eavesy.' },
  };
  const result = await sendWebhook(endpoint, event, now);
  return { delivered: result.error === null, status: result.status, error: result.error, event_id: event.id };
}

type TokenRow = typeof mcpTokens.$inferSelect;

/** Whether the key that added an endpoint still works. An endpoint added in the web app has none. */
function addedByLiveKey(token: TokenRow | null, tokenId: string | null, now: number): boolean {
  if (tokenId === null) return true;
  if (!token || token.revokedAt !== null) return false;
  // An OAuth connection lasts as long as its refresh token.
  const expiresAt = token.clientId ? token.refreshExpiresAt : mcpTokenExpiresAt(token);
  return expiresAt === null || expiresAt > now;
}

/**
 * Queues an event for every enabled endpoint of the account that subscribes
 * to it. Best effort: an event that can't be queued is reported, and the
 * caller's own work goes on.
 */
export async function emitWebhookEvent(
  env: WebhookEnv,
  userId: string,
  type: WebhookEventType,
  data: WebhookItem,
  now = Date.now(),
  opts: { eventId?: string; throwOnFailure?: boolean } = {},
) {
  try {
    const db = drizzle(env.DB, { schema });
    const endpoints = await db
      .select({ id: webhookEndpoints.id, eventsJson: webhookEndpoints.eventsJson, tokenId: webhookEndpoints.createdByTokenId, token: mcpTokens })
      .from(webhookEndpoints)
      .leftJoin(mcpTokens, eq(mcpTokens.id, webhookEndpoints.createdByTokenId))
      .where(and(eq(webhookEndpoints.userId, userId), isNull(webhookEndpoints.disabledAt)));
    const targets = endpoints.filter(
      (endpoint) => parseEvents(endpoint.eventsJson).includes(type) && addedByLiveKey(endpoint.token, endpoint.tokenId, now),
    );
    if (!targets.length) return;
    const event: WebhookEvent = { id: opts.eventId ?? pid('evt', now), type, timestamp: new Date(now).toISOString(), data };
    for (const endpoint of targets) {
      await env.PROCESSING_QUEUE.send({ kind: 'deliver-webhook', endpointId: endpoint.id, event, attempt: 1 });
    }
  } catch (error) {
    if (opts.throwOnFailure) throw error;
    reportError('webhook event not queued', error, { event_type: type, item_id: data.id });
  }
}

/**
 * The queue job: one attempt at one delivery. A failed attempt queues the
 * next one itself, so the queue's own retries are left for D1 errors.
 */
export async function deliverWebhook(db: Db, queue: QueueLike, delivery: WebhookDelivery, now = Date.now()) {
  const found = (
    await db
      .select({ endpoint: webhookEndpoints, token: mcpTokens })
      .from(webhookEndpoints)
      .leftJoin(mcpTokens, eq(mcpTokens.id, webhookEndpoints.createdByTokenId))
      .where(eq(webhookEndpoints.id, delivery.endpointId))
      .limit(1)
  )[0];
  const endpoint = found?.endpoint;
  // Deleted, turned off, or its key revoked since the event was queued.
  if (!endpoint || endpoint.disabledAt !== null || !addedByLiveKey(found.token, endpoint.createdByTokenId, now)) return;
  const result = await sendWebhook(endpoint, delivery.event, now);
  const attempted = { lastAttemptAt: now, lastStatus: result.status, lastError: result.error };
  if (result.error === null) {
    await db
      .update(webhookEndpoints)
      .set({ ...attempted, lastSuccessAt: now, failedEvents: 0 })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return;
  }
  const delay = WEBHOOK_RETRY_DELAYS_SEC[delivery.attempt - 1];
  if (delay !== undefined) {
    await db.update(webhookEndpoints).set(attempted).where(eq(webhookEndpoints.id, endpoint.id));
    await queue.send({ ...delivery, attempt: delivery.attempt + 1 }, { delaySeconds: delay });
    return;
  }
  const failing = sql`${webhookEndpoints.failedEvents} + 1 >= ${WEBHOOK_DISABLE_AFTER}`;
  await db
    .update(webhookEndpoints)
    .set({
      ...attempted,
      failedEvents: sql`${webhookEndpoints.failedEvents} + 1`,
      disabledAt: sql`CASE WHEN ${failing} THEN ${now} ELSE ${webhookEndpoints.disabledAt} END`,
      disabledReason: sql`CASE WHEN ${failing} THEN ${`Turned off after ${WEBHOOK_DISABLE_AFTER} events in a row could not be delivered.`} ELSE ${webhookEndpoints.disabledReason} END`,
    })
    .where(eq(webhookEndpoints.id, endpoint.id));
}

/** The bindings emitWebhookEvent needs, from inside a web app request. */
export function webhookEnv(): WebhookEnv {
  return getCloudflareContext().env as unknown as WebhookEnv;
}
