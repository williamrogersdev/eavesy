/**
 * Agent messages for the Mac (docs/plans/voice-conversation.md, piece 2): an
 * agent on a remote MCP connection calls `send_to_human` or `ask_human`, the
 * user's Mac picks the message up on its next poll, shows and speaks it, and
 * the answer typed on the card goes back to the call that asked, and only to
 * it.
 *
 * Everything an agent sends is untrusted text: it is clipped, stripped of
 * control characters, shown and spoken. Nothing here runs it, and an answer is
 * data for the agent, never an approval.
 *
 * Relative imports only: the MCP Worker uses this module directly.
 */
import { and, count, eq, gt, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '../db/schema';

type Db = DrizzleD1Database<typeof schema>;
type Row = typeof schema.agentMessages.$inferSelect;

export const MAX_TEXT_CHARS = 4_000;
export const MAX_SPOKEN_CHARS = 300;
export const MAX_CHOICES = 6;
export const MAX_CHOICE_CHARS = 80;
/** The same cap as a reply to a Claude Code session (desktop agents/protocol.rs). */
export const MAX_ANSWER_CHARS = 20_000;
export const MAX_SOURCE_CHARS = 40;

/**
 * `ask_human` holds the MCP call open while it waits, and clients cut tool
 * calls off at limits of their own, so the default is short.
 */
export const ASK_DEFAULT_SEC = 120;
export const ASK_MIN_SEC = 30;
export const ASK_MAX_SEC = 600;
/** A message waits this long for a Mac to come online; after that it's old news. */
export const SEND_TTL_MS = 2 * 60 * 60 * 1000;
/** Rows are deleted this long after they stop mattering. */
export const RETAIN_MS = 24 * 60 * 60 * 1000;
/** A Mac that asked this recently is listening. It polls every few seconds. */
export const LISTENING_MS = 45_000;
/** How often a polling Mac's `seen_at` is written. */
const LISTENER_WRITE_MS = 15_000;
/** How often a held `ask_human` call marks its ask as still waiting. */
export const HEARTBEAT_MS = 10_000;
/** An ask whose call hasn't marked it this recently has lost its caller. */
export const HELD_MS = 25_000;
/** Undelivered messages a user can have at once, so a looping agent can't pile them up. */
export const MAX_PENDING = 20;
/** Messages one Mac picks up per poll. */
const PER_POLL = 10;

/** A message for the person calling the tool. */
export class AgentInboxError extends Error {}

/**
 * Agent text made safe to show and speak: no control characters but newlines
 * and tabs; no soft hyphens, zero-width spaces, word joiners, or direction
 * marks, embeddings, overrides and isolates, which could hide or reorder words
 * on the card. Zero-width joiners stay, since emoji are built with them.
 * Trimmed and clipped.
 */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '').trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;
}

/** One line: whitespace collapsed. */
function cleanLine(value: unknown, max: number): string {
  return cleanText(typeof value === 'string' ? value.replace(/\s+/g, ' ') : value, max);
}

/**
 * The name said before a message ("ChatGPT says…"). A connection's name can
 * come from the client's own registration, so it's clipped like agent text.
 */
export function sourceLabel(name: string | null | undefined): string {
  return cleanLine(name, MAX_SOURCE_CHARS) || 'An agent';
}

/** Seconds the caller asked to wait, clamped to what a held call allows. */
export function askTimeoutSec(value: unknown): number {
  const seconds = Math.trunc(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return ASK_DEFAULT_SEC;
  return Math.max(ASK_MIN_SEC, Math.min(seconds, ASK_MAX_SEC));
}

export interface SendInput {
  text: string;
  spoken: string | null;
}

export interface AskInput {
  question: string;
  spoken: string | null;
  choices: string[];
  timeoutSec: number;
}

export function parseSend(args: Record<string, unknown>): SendInput {
  const text = cleanText(args.text, MAX_TEXT_CHARS);
  if (!text) throw new AgentInboxError('text is required');
  return { text, spoken: cleanLine(args.spoken, MAX_SPOKEN_CHARS) || null };
}

export function parseAsk(args: Record<string, unknown>): AskInput {
  const question = cleanText(args.question, MAX_TEXT_CHARS);
  if (!question) throw new AgentInboxError('question is required');
  if (args.choices !== undefined && !Array.isArray(args.choices)) throw new AgentInboxError('choices must be a list of strings');
  const choices = [...new Set((Array.isArray(args.choices) ? args.choices : []).map((choice) => cleanLine(choice, MAX_CHOICE_CHARS)).filter(Boolean))];
  if (choices.length > MAX_CHOICES) throw new AgentInboxError(`at most ${MAX_CHOICES} choices`);
  return { question, spoken: cleanLine(args.spoken, MAX_SPOKEN_CHARS) || null, choices, timeoutSec: askTimeoutSec(args.timeout_sec) };
}

/** Whether any of the user's Macs is listening for agent messages right now. */
export async function macListening(db: Db, userId: string, now = Date.now()): Promise<boolean> {
  const rows = await db
    .select({ deviceId: schema.agentListeners.deviceId })
    .from(schema.agentListeners)
    .where(and(eq(schema.agentListeners.userId, userId), gt(schema.agentListeners.seenAt, now - LISTENING_MS)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether the user has a Mac with agent messages on at all: one polled within
 * the last day (older listeners are deleted). Without one, a message is
 * dropped rather than piled up for a Mac that may never ask.
 */
export async function macEnabled(db: Db, userId: string): Promise<boolean> {
  const rows = await db
    .select({ deviceId: schema.agentListeners.deviceId })
    .from(schema.agentListeners)
    .where(eq(schema.agentListeners.userId, userId))
    .limit(1);
  return rows.length > 0;
}

export interface NewMessage {
  userId: string;
  mcpTokenId: string;
  source: string;
  kind: 'send' | 'ask';
  text: string;
  spoken: string | null;
  choices?: string[];
  ttlMs: number;
}

/**
 * Refuses once too many messages are waiting. Approximate: two calls at the
 * same moment can both pass, which only lets the cap run over by a few.
 */
export async function assertRoom(db: Db, userId: string, now = Date.now()): Promise<void> {
  const [waiting] = await db
    .select({ n: count() })
    .from(schema.agentMessages)
    .where(and(eq(schema.agentMessages.userId, userId), eq(schema.agentMessages.status, 'pending'), gt(schema.agentMessages.expiresAt, now)));
  if ((waiting?.n ?? 0) >= MAX_PENDING) {
    throw new AgentInboxError('Too many messages are already waiting for this person. Wait for them to catch up before sending more.');
  }
}

/** Stores a message for the user's Macs. Refuses once too many are waiting. */
export async function createMessage(db: Db, message: NewMessage, now = Date.now()): Promise<string> {
  await assertRoom(db, message.userId, now);
  const id = crypto.randomUUID();
  await db.insert(schema.agentMessages).values({
    id,
    userId: message.userId,
    mcpTokenId: message.mcpTokenId,
    source: sourceLabel(message.source),
    kind: message.kind,
    text: message.text,
    spoken: message.spoken,
    choicesJson: message.choices?.length ? JSON.stringify(message.choices) : null,
    status: 'pending',
    createdAt: now,
    expiresAt: now + message.ttlMs,
    heldAt: message.kind === 'ask' ? now : null,
  });
  return id;
}

export type AskResult =
  | { status: 'answered'; text: string }
  | { status: 'dismissed' }
  | { status: 'timeout' }
  | { status: 'mac_offline' };

function finished(row: Pick<Row, 'status' | 'answer'> | undefined): AskResult | null {
  if (row?.status === 'answered') return { status: 'answered', text: row.answer ?? '' };
  if (row?.status === 'dismissed') return { status: 'dismissed' };
  if (row?.status === 'timeout') return { status: 'timeout' };
  return null;
}

async function readAsk(db: Db, id: string) {
  const [row] = await db
    .select({ status: schema.agentMessages.status, answer: schema.agentMessages.answer })
    .from(schema.agentMessages)
    .where(eq(schema.agentMessages.id, id))
    .limit(1);
  return row;
}

export interface WaitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How often the row is read at first; after a minute, half as often. */
  everyMs?: number;
}

/**
 * Waits for the answer to the ask `id` the caller just created, until
 * `deadline`, marking the ask as held every `HEARTBEAT_MS`: if the client cuts
 * the call off, the marks stop, the Mac drops the card and no answer is taken
 * for nobody. On time out the ask is closed; an answer that landed at the same
 * moment still wins.
 */
export async function waitForAnswer(db: Db, id: string, deadline: number, options: WaitOptions = {}): Promise<AskResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const everyMs = options.everyMs ?? 1_500;
  const started = now();
  let beat = started;
  for (;;) {
    const result = finished(await readAsk(db, id));
    if (result) return result;
    const left = deadline - now();
    if (left <= 0) break;
    if (now() - beat >= HEARTBEAT_MS) {
      beat = now();
      await db
        .update(schema.agentMessages)
        .set({ heldAt: beat })
        .where(and(eq(schema.agentMessages.id, id), eq(schema.agentMessages.status, 'pending')));
    }
    await sleep(Math.min(now() - started < 60_000 ? everyMs : everyMs * 2, left));
  }
  await db
    .update(schema.agentMessages)
    .set({ status: 'timeout', resolvedAt: now() })
    .where(and(eq(schema.agentMessages.id, id), eq(schema.agentMessages.status, 'pending')));
  return finished(await readAsk(db, id)) ?? { status: 'timeout' };
}

/** A message as a Mac receives it. */
export interface DeliveredMessage {
  id: string;
  kind: 'send' | 'ask';
  source: string;
  text: string;
  spoken: string | null;
  choices: string[];
  expires_at: number;
}

function parseChoices(json: string | null): string[] {
  try {
    const value: unknown = JSON.parse(json ?? '[]');
    return Array.isArray(value) ? value.filter((choice): choice is string => typeof choice === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * One poll from a Mac: marks it listening, hands it the messages no other Mac
 * has taken plus its own asks still waiting (so a Mac that restarted shows
 * them again; it ignores ones it already shows), and lists those asks' ids,
 * so it can drop a card that timed out. A message goes to the first Mac that
 * asks; a `send` counts as delivered then. An ask held by a Mac that stopped
 * polling goes to the next Mac that does.
 */
export async function pollForDevice(db: Db, userId: string, deviceId: string, now = Date.now()) {
  await db
    .insert(schema.agentListeners)
    .values({ deviceId, userId, seenAt: now })
    .onConflictDoUpdate({
      target: schema.agentListeners.deviceId,
      set: { userId, seenAt: now },
      // Written only when stale, so a Mac polling every few seconds rarely writes.
      setWhere: or(lte(schema.agentListeners.seenAt, now - LISTENER_WRITE_MS), ne(schema.agentListeners.userId, userId)),
    });
  // A send waits for a Mac; an ask only while its call is still held.
  const open = and(
    eq(schema.agentMessages.userId, userId),
    eq(schema.agentMessages.status, 'pending'),
    gt(schema.agentMessages.expiresAt, now),
    or(eq(schema.agentMessages.kind, 'send'), gt(schema.agentMessages.heldAt, now - HELD_MS)),
  );
  const free = or(
    isNull(schema.agentMessages.deviceId),
    sql`${schema.agentMessages.deviceId} NOT IN (SELECT ${schema.agentListeners.deviceId} FROM ${schema.agentListeners} WHERE ${schema.agentListeners.seenAt} > ${now - LISTENING_MS})`,
  );
  const unclaimed = await db
    .select({ id: schema.agentMessages.id })
    .from(schema.agentMessages)
    .where(and(open, free))
    .orderBy(schema.agentMessages.createdAt)
    .limit(PER_POLL);
  const delivered: Row[] = [];
  if (unclaimed.length) {
    // Claimed in one statement, so two Macs polling at once never both get one.
    const claimed = await db
      .update(schema.agentMessages)
      .set({ deviceId })
      .where(and(open, free, inArray(schema.agentMessages.id, unclaimed.map((row) => row.id))))
      .returning();
    const sends = claimed.filter((row) => row.kind === 'send').map((row) => row.id);
    if (sends.length) {
      await db
        .update(schema.agentMessages)
        .set({ status: 'delivered', resolvedAt: now })
        .where(inArray(schema.agentMessages.id, sends));
    }
    delivered.push(...claimed.filter((row) => row.kind === 'send'));
  }
  const asks = await db
    .select()
    .from(schema.agentMessages)
    .where(and(open, eq(schema.agentMessages.kind, 'ask'), eq(schema.agentMessages.deviceId, deviceId)));
  const items: DeliveredMessage[] = [...delivered, ...asks]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      source: row.source,
      text: row.text,
      spoken: row.spoken,
      choices: parseChoices(row.choicesJson),
      expires_at: row.expiresAt,
    }));
  return { items, waiting: asks.map((row) => row.id) };
}

/**
 * The Mac that showed an ask answers or dismisses it. False when it's no
 * longer waiting (timed out, its call is gone, or it's not this Mac's).
 */
export async function resolveForDevice(
  db: Db,
  userId: string,
  deviceId: string,
  id: string,
  outcome: { status: 'answered'; text: string } | { status: 'dismissed' },
  now = Date.now(),
): Promise<boolean> {
  const rows = await db
    .update(schema.agentMessages)
    .set({ status: outcome.status, answer: outcome.status === 'answered' ? outcome.text : null, resolvedAt: now })
    .where(
      and(
        eq(schema.agentMessages.id, id),
        eq(schema.agentMessages.userId, userId),
        eq(schema.agentMessages.deviceId, deviceId),
        eq(schema.agentMessages.kind, 'ask'),
        eq(schema.agentMessages.status, 'pending'),
        gt(schema.agentMessages.expiresAt, now),
        gt(schema.agentMessages.heldAt, now - HELD_MS),
      ),
    )
    .returning({ id: schema.agentMessages.id });
  return rows.length > 0;
}
