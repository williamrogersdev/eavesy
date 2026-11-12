import { and, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { emailDeliveries, meetings, providerWebhookEvents, summaries, transcriptSegments, users } from '@/db/schema';
import { type ActionItem, type Decision, decode } from '@/db/codec';
import { pid } from '@/db/ids';
import type { AppDb } from '@/db/client';
import { clock } from '@/lib/ai/chapters';
import { parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import type { QueueMessage } from '@/server/queue';
import { verifySvixWebhook } from '@/server/svix';
import { type EmailEnv, EmailError, type OutgoingEmail, type SendingEmailEnv, appUrl, emailConfigured, sendEmail } from './resend';

export type EmailDelivery = typeof emailDeliveries.$inferSelect;
export type DeliveryStatus = EmailDelivery['status'];
export interface RecapEnv extends EmailEnv {
  PROCESSING_QUEUE: { send(message: QueueMessage, options?: { delaySeconds?: number }): Promise<unknown> };
}

/**
 * How far each status is along an email's life; webhooks only move it forward.
 * `unknown` sits just past `queued`: any provider event settles it.
 */
export const DELIVERY_STATUS_ORDER: Record<DeliveryStatus, number> = {
  queued: 0,
  unknown: 1,
  sent: 2,
  delivered: 3,
  failed: 4,
  bounced: 4,
  // A complaint arrives after delivery, and can follow a soft bounce.
  complained: 5,
};

/** Transcripts larger than this go out as a link only; Resend's limit is 40 MB. */
export const MAX_TRANSCRIPT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** A queued recap whose queue message was lost is sent again this long after it was last touched. */
export const RECAP_REQUEUE_AFTER_MS = 30 * 60 * 1_000;
/** A recap still unsent this long after its meeting finished isn't worth sending. */
export const RECAP_EXPIRE_AFTER_MS = 24 * 60 * 60 * 1_000;
/** The tag Resend echoes on every webhook, naming our row. */
const DELIVERY_TAG = 'eavesy_delivery';

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A plain address from the account, or null when there's nothing safe to send to. */
export function recipientAddress(email: string | null | undefined): string | null {
  const address = email?.trim().toLowerCase();
  if (!address || address.length > 254 || !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(address)) return null;
  return address;
}

export function recapIdempotencyKey(meetingId: string, recipient: string) {
  return `meeting_recap:${meetingId}:${recipient}`;
}

interface RecapUser {
  isAnonymous: boolean;
  email: string | null;
  emailRecaps: boolean;
}
type User = typeof users.$inferSelect;
type Meeting = typeof meetings.$inferSelect;

/** Whether a finished meeting of this account gets a recap. Recipients are the owner only. */
export function wantsRecap(env: EmailEnv, user: RecapUser | null | undefined): boolean {
  return Boolean(emailConfigured(env) && user && !user.isAnonymous && user.emailRecaps && recipientAddress(user.email));
}

/** Called where a meeting reaches `complete` with a summary: queues the send, never sends inline. */
export async function queueRecap(env: RecapEnv, user: RecapUser | null | undefined, meetingId: string) {
  if (!wantsRecap(env, user)) return;
  await env.PROCESSING_QUEUE.send({ kind: 'send-recap', meetingId });
}

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The transcript as plain text, one line per turn, with times and speaker names. */
export function transcriptAttachment(
  lines: { speakerId: string | null; startMs: number; text: string }[],
  speakerNamesJson: string | null,
) {
  const names = parseSpeakerNames(speakerNamesJson);
  return lines
    .map((line) => `[${clock(line.startMs)}] ${line.speakerId ? `${speakerName(line.speakerId, names)}: ` : ''}${line.text}`)
    .join('\n');
}

export interface RecapContent {
  title: string;
  startedAt: number | null;
  tldr: string;
  decisions: Decision[];
  actionItems: ActionItem[];
  /** What the meeting left unanswered, as the meeting's panel and page show it. */
  openQuestions?: { text: string }[];
  link: string;
  attachmentNote?: string | null;
  /** The "Send to everyone" button: a page in the app that asks before sending anything. */
  shareLink?: string | null;
  /** Set when Eavesy switched recaps on for this account: the one-click page that turns them off. */
  autoEnabledOffLink?: string | null;
}

/** The notice an account switched on by the default-on migration gets in its next recap. */
export const AUTO_ENABLED_NOTICE = 'We now email you notes after every meeting. Don’t want them?';

export function renderRecap(content: RecapContent) {
  const subject = `Recap: ${content.title}`.slice(0, 200);
  const when = content.startedAt
    ? new Date(content.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    : null;
  const decisions = content.decisions.map((d) => d.text).filter(Boolean);
  const actions = content.actionItems.filter((a) => a.text).map((a) => {
    const meta = [a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', ');
    return { text: a.text, meta };
  });
  const questions = (content.openQuestions ?? []).map((q) => q.text).filter(Boolean);

  const text = [
    content.title,
    when,
    '',
    'TL;DR',
    content.tldr || 'No summary was written for this meeting.',
    ...(decisions.length ? ['', 'Decisions', ...decisions.map((d) => `- ${d}`)] : []),
    ...(actions.length ? ['', 'Action items', ...actions.map((a) => `- ${a.text}${a.meta ? ` (${a.meta})` : ''}`)] : []),
    ...(questions.length ? ['', 'Open questions', ...questions.map((q) => `- ${q}`)] : []),
    '',
    `Transcript: ${content.link}`,
    ...(content.attachmentNote ? [content.attachmentNote] : []),
    ...(content.shareLink ? ['', `Send these notes to everyone in the meeting (you'll review the list first): ${content.shareLink}`] : []),
    ...(content.autoEnabledOffLink ? ['', `${AUTO_ENABLED_NOTICE} Turn them off: ${content.autoEnabledOffLink}`] : []),
    '',
    'You get this because email recaps are on in your Eavesy settings.',
  ].filter((line) => line !== null).join('\n');

  const section = (heading: string, items: string[]) => items.length
    ? `<h2 style="font-size:15px;margin:24px 0 8px">${heading}</h2><ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:4px 0">${i}</li>`).join('')}</ul>`
    : '';
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1917;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(content.title)}</h1>
${when ? `<p style="color:#78716c;margin:0 0 16px;font-size:13px">${escapeHtml(when)}</p>` : ''}
<h2 style="font-size:15px;margin:24px 0 8px">TL;DR</h2>
<p style="margin:0">${escapeHtml(content.tldr || 'No summary was written for this meeting.')}</p>
${section('Decisions', decisions.map(escapeHtml))}
${section('Action items', actions.map((a) => `${escapeHtml(a.text)}${a.meta ? ` <span style="color:#78716c">(${escapeHtml(a.meta)})</span>` : ''}`))}
${section('Open questions', questions.map(escapeHtml))}
<p style="margin:24px 0 0"><a href="${escapeHtml(content.link)}" style="color:#1c1917">Open the transcript</a></p>
${content.attachmentNote ? `<p style="color:#78716c;font-size:13px">${escapeHtml(content.attachmentNote)}</p>` : ''}
${content.shareLink ? `<p style="margin:24px 0 0"><a href="${escapeHtml(content.shareLink)}" style="display:inline-block;background:#1c1917;color:#fafaf9;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:999px">Send to everyone</a></p>
<p style="color:#78716c;font-size:13px;margin:6px 0 0">You'll see who gets it before anything is sent.</p>` : ''}
${content.autoEnabledOffLink ? `<p style="color:#78716c;font-size:13px;margin-top:24px">${escapeHtml(AUTO_ENABLED_NOTICE)} <a href="${escapeHtml(content.autoEnabledOffLink)}" style="color:#78716c">Turn them off</a>.</p>` : ''}
<p style="color:#a8a29e;font-size:12px;margin-top:32px">You get this because email recaps are on in your Eavesy settings.</p>
</body></html>`;
  return { subject, html, text };
}

export function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Which of these addresses get nothing more: a complaint, a permanent bounce
 * or a provider suppression. With `fromUserId`, only that account's own email
 * history counts, so one account's outcomes never block or show up for
 * another; Resend still refuses addresses on its own suppression list, which
 * protects the shared sending domain.
 */
export async function suppressedAmong(db: AppDb, recipients: string[], fromUserId?: string) {
  if (!recipients.length) return new Set<string>();
  const rows = await db.select({ recipient: emailDeliveries.recipient, status: emailDeliveries.status, detail: emailDeliveries.statusDetail })
    .from(emailDeliveries)
    .where(and(
      inArray(emailDeliveries.recipient, recipients),
      inArray(emailDeliveries.status, ['bounced', 'complained', 'failed']),
      ...(fromUserId ? [eq(emailDeliveries.userId, fromUserId)] : []),
    ));
  return new Set(rows.filter((row) => row.status === 'complained'
    || (row.status === 'bounced' && row.detail === 'permanent')
    || (row.status === 'failed' && row.detail === 'provider_suppressed')).map((row) => row.recipient));
}

/** Whether this address has bounced for good or complained before; such addresses get nothing more. */
export async function suppressed(db: AppDb, recipient: string, fromUserId?: string) {
  return (await suppressedAmong(db, [recipient], fromUserId)).has(recipient);
}

async function setStatus(db: AppDb, id: string, from: DeliveryStatus, values: Partial<EmailDelivery>) {
  return db.update(emailDeliveries).set({ ...values, updatedAt: Date.now() })
    .where(and(eq(emailDeliveries.id, id), eq(emailDeliveries.status, from)))
    .returning({ id: emailDeliveries.id });
}

/**
 * Queue job: emails the owner the recap of a completed meeting. Safe to run
 * again: the delivery row is keyed per meeting and recipient, and only a row
 * still `queued` is ever sent (see `deliver`). Answers `recapped` only once
 * the provider accepted the owner's recap, which is when notes may go on to
 * attendees automatically: never while the owner's own copy failed.
 */
export async function sendRecap(db: AppDb, env: RecapEnv, meetingId: string, now = Date.now()): Promise<'recapped' | 'not_sent'> {
  if (!emailConfigured(env)) return 'not_sent';
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete') return 'not_sent';
  const user = (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  if (!wantsRecap(env, user)) return 'not_sent';
  const recipient = recipientAddress(user.email)!;

  const idempotencyKey = recapIdempotencyKey(meetingId, recipient);
  await db.insert(emailDeliveries).values({
    id: pid('eml', now),
    userId: user.id,
    meetingId,
    kind: 'meeting_recap',
    recipient,
    idempotencyKey,
    provider: 'resend',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: emailDeliveries.idempotencyKey });
  const delivery = (await db.select().from(emailDeliveries).where(eq(emailDeliveries.idempotencyKey, idempotencyKey)).limit(1))[0];
  if (!delivery) return 'not_sent';
  // Sent, settled, or attempted without an answer: never send it again.
  if (delivery.status !== 'queued') return delivery.status === 'sent' || delivery.status === 'delivered' ? 'recapped' : 'not_sent';

  if (await suppressed(db, recipient, user.id)) {
    await setStatus(db, delivery.id, 'queued', { status: 'failed', statusDetail: 'suppressed_recipient' });
    return 'not_sent';
  }

  const summary = (await db.select().from(summaries).where(eq(summaries.meetingId, meetingId)).limit(1))[0];
  const { attachments, attachmentNote } = user.emailRecapTranscript
    ? await transcriptFiles(db, meeting)
    : { attachments: [], attachmentNote: null };
  const app = appUrl(env);
  const rendered = renderRecap({
    title: meeting.title,
    startedAt: meeting.startedAt,
    tldr: summary?.tldr ?? '',
    decisions: decode<Decision[]>(summary?.decisionsJson, []),
    actionItems: decode<ActionItem[]>(summary?.actionItemsJson, []),
    openQuestions: decode<{ text: string }[]>(summary?.openQuestionsJson, []),
    link: `${app}/app/meetings/${encodeURIComponent(meetingId)}`,
    attachmentNote,
    shareLink: user.shareNotesOffer ? `${app}/app/meetings/${encodeURIComponent(meetingId)}/share-notes` : null,
    autoEnabledOffLink: user.emailRecapsNoticePending ? `${app}/recaps/off/${await recapsOffToken(db, user)}` : null,
  });

  const outcome = await deliver(db, env, delivery, { to: recipient, ...rendered, attachments });
  if (outcome === 'sent' && user.emailRecapsNoticePending) {
    // Said once is enough. A rejected or unconfirmed send keeps it for the next recap.
    await db.update(users).set({ emailRecapsNoticePending: false }).where(eq(users.id, user.id));
  }
  return outcome === 'sent' ? 'recapped' : 'not_sent';
}

/** The transcript as a text attachment, or a note saying why it isn't attached. */
export async function transcriptFiles(db: AppDb, meeting: Pick<Meeting, 'id' | 'speakerNamesJson'>) {
  const lines = await db.select().from(transcriptSegments).where(eq(transcriptSegments.meetingId, meeting.id)).orderBy(transcriptSegments.startMs);
  const text = transcriptAttachment(lines, meeting.speakerNamesJson);
  if (new TextEncoder().encode(text).length > MAX_TRANSCRIPT_ATTACHMENT_BYTES) {
    return { attachments: [] as EmailAttachment[], attachmentNote: 'The transcript is too long to attach; open it with the link above.' as string | null };
  }
  const attachments: EmailAttachment[] = text
    ? [{ filename: 'transcript.txt', content: toBase64(text), contentType: 'text/plain; charset=utf-8' }]
    : [];
  return { attachments, attachmentNote: null as string | null };
}

export type EmailAttachment = { filename: string; content: string; contentType: string };

/** The secret in this account's one-click "turn off recaps" link, made the first time it's needed. */
export async function recapsOffToken(db: AppDb, user: Pick<User, 'id' | 'emailRecapsOffToken'>) {
  if (user.emailRecapsOffToken) return user.emailRecapsOffToken;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await db.update(users).set({ emailRecapsOffToken: token }).where(and(eq(users.id, user.id), isNull(users.emailRecapsOffToken)));
  const row = (await db.select({ token: users.emailRecapsOffToken }).from(users).where(eq(users.id, user.id)).limit(1))[0];
  return row?.token ?? token;
}

/** Turns recaps off for the account a one-click link belongs to. Returns whether the token matched an account. */
export async function turnOffRecapsByToken(db: AppDb, token: string, now = Date.now()) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return false;
  const changed = await db.update(users)
    // The link works once: a forwarded old recap can't turn them off again later.
    .set({ emailRecaps: false, emailRecapsOffReason: 'user', emailRecapsSetAt: now, emailRecapsNoticePending: false, emailRecapsOffToken: null, updatedAt: now })
    .where(eq(users.emailRecapsOffToken, token))
    .returning({ id: users.id });
  return changed.length > 0;
}

/**
 * Claims a `queued` delivery and sends it. The row is claimed as `unknown`
 * before the provider call, so a crash or timeout mid-send never leads to a
 * second email. A rate-limited send goes back to `queued` and throws, for the
 * queue to retry.
 */
export async function deliver(
  db: AppDb,
  env: SendingEmailEnv,
  delivery: EmailDelivery,
  email: Pick<OutgoingEmail, 'to' | 'subject' | 'html' | 'text' | 'attachments'>,
): Promise<'sent' | 'unconfirmed' | 'rejected' | 'not_sent'> {
  const claimed = await db.update(emailDeliveries)
    .set({ status: 'unknown', statusDetail: 'sending', attempts: delivery.attempts + 1, updatedAt: Date.now() })
    .where(and(eq(emailDeliveries.id, delivery.id), eq(emailDeliveries.status, 'queued')))
    .returning({ id: emailDeliveries.id });
  if (!claimed.length) return 'not_sent'; // another run claimed it first
  const meetingId = delivery.meetingId;

  try {
    const sent = await sendEmail(env, {
      ...email,
      tags: { [DELIVERY_TAG]: delivery.id, kind: delivery.kind },
      // A later attempt only happens after one that certainly didn't send
      // (rate limited, rejected, or a resend of failed notes), so it gets its own key.
      idempotencyKey: delivery.attempts ? `${delivery.id}:${delivery.attempts + 1}` : delivery.id,
    });
    await db.update(emailDeliveries).set({ providerMessageId: sent.id })
      .where(and(eq(emailDeliveries.id, delivery.id), isNull(emailDeliveries.providerMessageId)));
    // A webhook may already have moved it past `sent`.
    await setStatus(db, delivery.id, 'unknown', { status: 'sent', statusDetail: null, sentAt: Date.now() });
    return 'sent';
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof EmailError && error.retryable) {
      // Refused before sending (rate limited): hand it back to the queue's retries.
      await setStatus(db, delivery.id, 'unknown', { status: 'queued', statusDetail: 'rate_limited' });
      throw error;
    }
    if (!(error instanceof EmailError) || error.uncertain) {
      // It may have gone out. Leave it `unknown`; a webhook can still settle it.
      console.error(JSON.stringify({ message: 'email send unconfirmed', kind: delivery.kind, deliveryId: delivery.id, meetingId, error: reason }));
      await setStatus(db, delivery.id, 'unknown', { statusDetail: 'send_unconfirmed' });
      return 'unconfirmed';
    }
    console.error(JSON.stringify({ message: 'email send rejected', kind: delivery.kind, deliveryId: delivery.id, meetingId, status: error.status, error: reason }));
    await setStatus(db, delivery.id, 'unknown', { status: 'failed', statusDetail: `provider_rejected_${error.status ?? 'unknown'}` });
    return 'rejected';
  }
}

/** Called when the send job runs out of queue retries: a recap never claimed is given up on. */
export async function failRecap(db: AppDb, meetingId: string, reason: string, kind: EmailDelivery['kind'] = 'meeting_recap') {
  await db.update(emailDeliveries)
    .set({ status: 'failed', statusDetail: `retries_exhausted: ${reason.slice(0, 200)}`, updatedAt: Date.now() })
    .where(and(eq(emailDeliveries.meetingId, meetingId), eq(emailDeliveries.kind, kind), eq(emailDeliveries.status, 'queued')));
}

interface ResendEvent {
  type: string;
  emailId: string | null;
  deliveryId: string | null;
  bounceType: string | null;
  at: number;
}

export function parseEmailEvent(body: unknown): ResendEvent | null {
  const root = body as { type?: unknown; created_at?: unknown; data?: Record<string, unknown> } | null;
  if (!root || typeof root.type !== 'string') return null;
  const data = root.data ?? {};
  // Webhooks carry tags as an object; accept the send API's array form too.
  const rawTags = data.tags;
  const tags: Record<string, unknown> = Array.isArray(rawTags)
    ? Object.fromEntries(rawTags.map((t: { name?: unknown; value?: unknown }) => [String(t?.name), t?.value]))
    : (typeof rawTags === 'object' && rawTags ? rawTags as Record<string, unknown> : {});
  const bounce = (data.bounce ?? {}) as { type?: unknown };
  const created = typeof root.created_at === 'string' ? Date.parse(root.created_at) : NaN;
  return {
    type: root.type,
    emailId: typeof data.email_id === 'string' ? data.email_id : null,
    deliveryId: typeof tags[DELIVERY_TAG] === 'string' ? tags[DELIVERY_TAG] : null,
    bounceType: typeof bounce.type === 'string' ? bounce.type.toLowerCase() : null,
    at: Number.isFinite(created) ? created : Date.now(),
  };
}

/** Maps a Resend event to our status and detail; null for events that don't change it (opens, delays). */
export function statusForEvent(event: ResendEvent): { status: DeliveryStatus; detail: string | null } | null {
  switch (event.type) {
    case 'email.sent': return { status: 'sent', detail: null };
    case 'email.delivered': return { status: 'delivered', detail: null };
    case 'email.bounced': return { status: 'bounced', detail: event.bounceType ?? 'undetermined' };
    case 'email.complained': return { status: 'complained', detail: null };
    case 'email.failed': return { status: 'failed', detail: 'provider_failed' };
    case 'email.suppressed': return { status: 'failed', detail: 'provider_suppressed' };
    default: return null;
  }
}

async function findDelivery(db: AppDb, event: ResendEvent): Promise<EmailDelivery | null> {
  if (event.emailId) {
    const byProvider = (await db.select().from(emailDeliveries)
      .where(and(eq(emailDeliveries.provider, 'resend'), eq(emailDeliveries.providerMessageId, event.emailId))).limit(1))[0];
    if (byProvider) return byProvider;
  }
  if (!event.deliveryId) return null;
  const byOurs = (await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, event.deliveryId)).limit(1))[0];
  if (!byOurs) return null;
  if (byOurs.providerMessageId && event.emailId && byOurs.providerMessageId !== event.emailId) return null;
  if (!byOurs.providerMessageId && event.emailId) {
    // The send timed out but Resend took it: adopt its id.
    await db.update(emailDeliveries).set({ providerMessageId: event.emailId }).where(eq(emailDeliveries.id, byOurs.id));
    return { ...byOurs, providerMessageId: event.emailId };
  }
  return byOurs;
}

/** Moves a delivery forward to what a provider event reports; repeats and stale events are no-ops. */
export async function applyEmailEvent(db: AppDb, delivery: EmailDelivery, event: ResendEvent) {
  const next = statusForEvent(event);
  if (!next || delivery.status === 'queued') return delivery.status;
  if (DELIVERY_STATUS_ORDER[next.status] <= DELIVERY_STATUS_ORDER[delivery.status]) return delivery.status;
  const changed = await setStatus(db, delivery.id, delivery.status, {
    status: next.status,
    statusDetail: next.detail,
    statusAt: Math.max(event.at, delivery.statusAt ?? 0),
    ...(delivery.sentAt ? {} : { sentAt: event.at }),
  });
  if (!changed.length) return delivery.status; // another delivery moved it first
  if (next.status === 'complained' && delivery.kind === 'meeting_recap') {
    // The owner marking a recap as spam is a clear no: stop sending them, and
    // remember why, so nothing switches them back on. An attendee's complaint
    // only suppresses that attendee's address.
    const now = Date.now();
    await db.update(users)
      .set({ emailRecaps: false, emailRecapsOffReason: 'complaint', emailRecapsSetAt: now, emailRecapsNoticePending: false, updatedAt: now })
      .where(eq(users.id, delivery.userId));
  }
  return next.status;
}

/** POST /api/webhooks/resend. Unknown emails are acknowledged so Resend stops retrying. */
export async function handleEmailWebhook(db: AppDb, env: EmailEnv, request: Request, now = Date.now()): Promise<Response> {
  if (!emailConfigured(env)) return json({ error: 'not_configured' }, 404);
  const length = Number(request.headers.get('content-length') ?? '0');
  if (length > 256 * 1024) return json({ error: 'too_large' }, 413);
  const body = await request.text();
  if (body.length > 256 * 1024) return json({ error: 'too_large' }, 413);
  const deliveryId = await verifySvixWebhook(env.RESEND_WEBHOOK_SECRET, request.headers, body, now);
  if (!deliveryId) return json({ error: 'invalid_signature' }, 401);
  const eventKey = `resend:${deliveryId}`.slice(0, 200);
  const seen = await db.select({ id: providerWebhookEvents.id }).from(providerWebhookEvents).where(eq(providerWebhookEvents.id, eventKey)).limit(1);
  if (seen.length) return json({ ok: true, duplicate: true });

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }
  const event = parseEmailEvent(parsed);
  if (event?.type.startsWith('email.')) {
    const delivery = await findDelivery(db, event);
    if (delivery) await applyEmailEvent(db, delivery, event);
  }
  // Recorded only after it was applied: a failure above makes Resend deliver it again.
  await db.insert(providerWebhookEvents).values({ id: eventKey, provider: 'resend', receivedAt: now }).onConflictDoNothing();
  return json({ ok: true });
}

/**
 * Hourly cron: re-queues recaps whose queue message was lost and expires stale
 * ones. Only `queued` rows are touched; `unknown` is left for a webhook to settle.
 */
export async function reconcileRecaps(db: AppDb, env: RecapEnv, now = Date.now()) {
  if (!emailConfigured(env)) return;
  await db.delete(providerWebhookEvents)
    .where(and(eq(providerWebhookEvents.provider, 'resend'), lt(providerWebhookEvents.receivedAt, now - 7 * 24 * 60 * 60 * 1_000)));
  await db.update(emailDeliveries)
    .set({ status: 'failed', statusDetail: 'expired', updatedAt: now })
    .where(and(eq(emailDeliveries.status, 'queued'), lt(emailDeliveries.createdAt, now - RECAP_EXPIRE_AFTER_MS)));
  const lost = await db.select().from(emailDeliveries)
    .where(and(
      eq(emailDeliveries.status, 'queued'),
      lt(emailDeliveries.updatedAt, now - RECAP_REQUEUE_AFTER_MS),
      gte(emailDeliveries.createdAt, now - RECAP_EXPIRE_AFTER_MS),
    ))
    .orderBy(emailDeliveries.updatedAt)
    .limit(50);
  const requeued = new Set<string>();
  for (const delivery of lost) {
    if (!delivery.meetingId) continue;
    await db.update(emailDeliveries).set({ updatedAt: now }).where(eq(emailDeliveries.id, delivery.id));
    const job = `${delivery.kind}:${delivery.meetingId}`;
    if (requeued.has(job)) continue; // one notes job sends every queued attendee of its meeting
    requeued.add(job);
    await env.PROCESSING_QUEUE.send(delivery.kind === 'meeting_notes'
      ? { kind: 'send-meeting-notes', meetingId: delivery.meetingId }
      : { kind: 'send-recap', meetingId: delivery.meetingId });
  }
}

/** Account deletion: forget every email sent to the account. */
export async function purgeAccountEmails(db: AppDb, userId: string) {
  await db.delete(emailDeliveries).where(eq(emailDeliveries.userId, userId));
}
