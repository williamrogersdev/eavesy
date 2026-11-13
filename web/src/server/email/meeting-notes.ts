/**
 * "Send to everyone": the owner's meeting notes emailed on to the people who
 * were in the meeting. Nothing here sends from a link: the owner picks the
 * recipients on a page and POSTs, or turns on automatic sending in Settings.
 * Each send is an `email_deliveries` row of kind `meeting_notes`, keyed per
 * meeting and recipient, so an address gets a meeting's notes at most once.
 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { calendarEvents, emailDeliveries, meetings, summaries, users } from '@/db/schema';
import { type ActionItem, type Decision, decode } from '@/db/codec';
import { pid } from '@/db/ids';
import type { AppDb } from '@/db/client';
import { parseSpeakerNames } from '@/lib/transcription/two-track';
import { type RecapEnv, deliver, escapeHtml, recapIdempotencyKey, recipientAddress, suppressedAmong, transcriptFiles } from './recaps';
import { appUrl, emailConfigured } from './resend';

type User = typeof users.$inferSelect;
type Meeting = typeof meetings.$inferSelect;
export type ShareScope = User['shareNotesScope'];

/** Most recipients one send may name. */
export const MAX_NOTE_RECIPIENTS = 50;
/** Most people one account emails notes to in 24 hours, however many sends that takes. */
export const MAX_NOTE_RECIPIENTS_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** Most addresses from outside the meeting one send may add. */
export const MAX_ADDED_RECIPIENTS = 10;
/** Most addresses from outside a meeting one account sends notes to in a day. */
export const MAX_ADDED_RECIPIENTS_PER_DAY = 30;
export const MAX_NOTE_LENGTH = 2_000;
/** How long a share link made for emailed notes stays open. */
export const SHARE_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

/**
 * Webmail domains: an owner on one of these has no company domain, so
 * "only my company's domain" lets nobody through rather than all of Gmail.
 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.net',
  'fastmail.com', 'hey.com', 'zoho.com', 'yandex.com', 'mail.com',
]);

export function emailDomain(address: string) {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/** The owner's company domain, or null when their address is a personal webmail one. */
export function companyDomain(ownerEmail: string | null | undefined) {
  const owner = recipientAddress(ownerEmail);
  if (!owner) return null;
  const domain = emailDomain(owner);
  return PERSONAL_DOMAINS.has(domain) ? null : domain;
}

/** Whether the owner's "Who can receive it" setting lets notes go to this address. */
export function recipientAllowed(scope: ShareScope, ownerEmail: string | null | undefined, recipient: string) {
  if (scope === 'everyone') return true;
  const domain = companyDomain(ownerEmail);
  return domain !== null && emailDomain(recipient) === domain;
}

/** Whether an address is outside the owner's own domain, to mark it on the page. */
export function isExternal(ownerEmail: string | null | undefined, recipient: string) {
  const owner = recipientAddress(ownerEmail);
  return !owner || emailDomain(owner) !== emailDomain(recipient);
}

export interface Attendee {
  /** Null for a named speaker with no known address: the owner types one in. */
  email: string | null;
  name: string | null;
  source: 'calendar' | 'speaker';
}

/**
 * Who was in the meeting: the calendar event's guests when the meeting came
 * from one, otherwise the speakers the owner named. The owner is left out.
 */
export async function meetingAttendees(db: AppDb, meeting: Pick<Meeting, 'id' | 'userId' | 'calendarEventId' | 'speakerNamesJson'>, ownerEmail: string | null): Promise<Attendee[]> {
  const owner = recipientAddress(ownerEmail);
  const event = (await db.select({ participantsJson: calendarEvents.participantsJson }).from(calendarEvents)
    .where(and(
      eq(calendarEvents.userId, meeting.userId),
      meeting.calendarEventId
        ? or(eq(calendarEvents.id, meeting.calendarEventId), eq(calendarEvents.recordedMeetingId, meeting.id))
        : eq(calendarEvents.recordedMeetingId, meeting.id),
    ))
    .limit(1))[0];
  if (event) {
    const seen = new Set<string>();
    const attendees: Attendee[] = [];
    for (const person of decode<{ email?: unknown; name?: unknown }[]>(event.participantsJson, [])) {
      const email = recipientAddress(typeof person?.email === 'string' ? person.email : null);
      if (!email || email === owner || seen.has(email)) continue;
      seen.add(email);
      attendees.push({ email, name: typeof person.name === 'string' && person.name.trim() ? person.name.trim() : null, source: 'calendar' });
    }
    if (attendees.length) return attendees;
  }
  const names = [...new Set(Object.values(parseSpeakerNames(meeting.speakerNamesJson)).map((n) => n.trim()).filter(Boolean))];
  return names.map((name) => ({ email: null, name, source: 'speaker' as const }));
}

/** The meeting's share link, made (or renewed when expired) for notes that point at it. */
export async function ensureShareLink(db: AppDb, meeting: Pick<Meeting, 'id' | 'shareSlug' | 'shareExpiresAt'>, now = Date.now()) {
  if (meeting.shareSlug && (!meeting.shareExpiresAt || meeting.shareExpiresAt > now)) return meeting.shareSlug;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const slug = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Only replace a missing or expired link, so two sends at once agree on one.
  await db.update(meetings).set({ shareSlug: slug, shareExpiresAt: now + SHARE_LINK_TTL_MS })
    .where(and(eq(meetings.id, meeting.id), or(isNull(meetings.shareSlug), lt(meetings.shareExpiresAt, now))));
  const row = (await db.select({ slug: meetings.shareSlug }).from(meetings).where(eq(meetings.id, meeting.id)).limit(1))[0];
  return row?.slug ?? slug;
}

export type QueueOutcome =
  | 'queued' | 'already_sent' | 'suppressed' | 'not_allowed' | 'invalid' | 'owner' | 'daily_limit'
  | 'needs_confirmation' | 'too_many_added';

/** Statuses that mean an address has (or may have) this meeting's notes, so it is never sent again. */
export const HAS_NOTES: readonly EmailDelivery['status'][] = ['queued', 'unknown', 'sent', 'delivered'];
type EmailDelivery = typeof emailDeliveries.$inferSelect;

/**
 * Records one delivery per allowed recipient and queues the job that sends
 * them. An address that has, or may have, this meeting's notes is left alone,
 * so nothing goes out twice; one whose earlier send certainly failed (refused
 * by the provider, blocked by a since-changed setting, a soft bounce) can be
 * sent again. People who weren't in the meeting need `confirmAdded`.
 * Each account emails at most `MAX_NOTE_RECIPIENTS_PER_DAY` people a day.
 */
export async function queueMeetingNotes(
  db: AppDb,
  env: RecapEnv,
  args: {
    user: User;
    meeting: Meeting;
    recipients: string[];
    note?: string | null;
    /** The owner confirmed sending to addresses that weren't in the meeting (added by hand). */
    confirmAdded?: boolean;
    /**
     * Charges one address from outside the meeting to the account's own daily
     * allowance for those (enforced by the caller's counter); false refuses it.
     */
    reserveAdded?: () => Promise<boolean>;
    now?: number;
  },
): Promise<{ email: string; outcome: QueueOutcome }[]> {
  const now = args.now ?? Date.now();
  const owner = recipientAddress(args.user.email);
  const note = args.note?.trim().slice(0, MAX_NOTE_LENGTH) || null;
  const results: { email: string; outcome: QueueOutcome }[] = [];
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const raw of args.recipients.slice(0, MAX_NOTE_RECIPIENTS)) {
    const email = recipientAddress(raw);
    if (!email) {
      results.push({ email: raw.slice(0, 254), outcome: 'invalid' });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    if (email === owner) results.push({ email, outcome: 'owner' });
    else if (!recipientAllowed(args.user.shareNotesScope, args.user.email, email)) results.push({ email, outcome: 'not_allowed' });
    else candidates.push(email);
  }

  // Addresses that weren't in the meeting go out only once the owner confirmed them, and only a few per send.
  const invited = new Set((await meetingAttendees(db, args.meeting, args.user.email)).flatMap((a) => (a.email ? [a.email] : [])));
  const outside = candidates.filter((email) => !invited.has(email));
  for (const email of outside.filter((_, i) => !args.confirmAdded || i >= MAX_ADDED_RECIPIENTS)) {
    candidates.splice(candidates.indexOf(email), 1);
    results.push({ email, outcome: args.confirmAdded ? 'too_many_added' : 'needs_confirmation' });
  }

  const [blocked, existing] = await Promise.all([
    suppressedAmong(db, candidates, args.user.id),
    candidates.length
      ? db.select().from(emailDeliveries).where(inArray(emailDeliveries.idempotencyKey, candidates.map((e) => recapIdempotencyKey(args.meeting.id, e))))
      : Promise.resolve([] as EmailDelivery[]),
  ]);
  const existingBy = new Map(existing.map((row) => [row.recipient, row]));
  // Checked inside each write, so two sends at once can't both spend the last of the day's cap.
  const underDailyCap = sql`(SELECT count(*) FROM email_deliveries
    WHERE user_id = ${args.user.id} AND kind = 'meeting_notes' AND created_at >= ${now - DAY_MS}
      AND status IN ('queued', 'unknown', 'sent', 'delivered')) < ${MAX_NOTE_RECIPIENTS_PER_DAY}`;
  let queued = 0;
  for (const email of candidates) {
    const before = existingBy.get(email);
    if (before && HAS_NOTES.includes(before.status)) {
      results.push({ email, outcome: 'already_sent' });
      continue;
    }
    if (blocked.has(email) || before?.status === 'complained') {
      results.push({ email, outcome: 'suppressed' });
      continue;
    }
    if (!invited.has(email) && args.reserveAdded && !(await args.reserveAdded())) {
      results.push({ email, outcome: 'daily_limit' });
      continue;
    }
    const key = recapIdempotencyKey(args.meeting.id, email);
    // A certainly-failed earlier send is queued again on the same row (its own provider key per attempt).
    const changed = before
      ? await db.update(emailDeliveries)
        // A fresh start: counted in today's cap, not expired by the hourly reconcile, and matched to the new email's webhooks.
        .set({ status: 'queued', statusDetail: 'resend', statusAt: null, providerMessageId: null, note, createdAt: now, updatedAt: now })
        .where(and(eq(emailDeliveries.id, before.id), inArray(emailDeliveries.status, ['failed', 'bounced']), eq(emailDeliveries.kind, 'meeting_notes'), underDailyCap))
        .returning({ id: emailDeliveries.id })
      : await db.all<{ id: string }>(sql`INSERT INTO email_deliveries
          (id, user_id, meeting_id, kind, recipient, idempotency_key, provider, status, note, attempts, created_at, updated_at)
          SELECT ${pid('eml', now)}, ${args.user.id}, ${args.meeting.id}, 'meeting_notes', ${email}, ${key}, 'resend', 'queued', ${note}, 0, ${now}, ${now}
          WHERE ${underDailyCap}
          ON CONFLICT (idempotency_key) DO NOTHING
          RETURNING id`);
    if (changed.length) {
      queued++;
      results.push({ email, outcome: 'queued' });
      continue;
    }
    // Nothing written: someone else queued it first, its status moved on, or the day's cap is spent.
    const current = (await db.select({ status: emailDeliveries.status }).from(emailDeliveries).where(eq(emailDeliveries.idempotencyKey, key)).limit(1))[0];
    results.push({
      email,
      outcome: current && HAS_NOTES.includes(current.status) ? 'already_sent' : current?.status === 'complained' ? 'suppressed' : 'daily_limit',
    });
  }
  if (queued) {
    await ensureShareLink(db, args.meeting, now);
    await env.PROCESSING_QUEUE.send({ kind: 'send-meeting-notes', meetingId: args.meeting.id });
  }
  // In the order the owner listed them.
  const order = new Map(args.recipients.map((raw, i) => [recipientAddress(raw) ?? raw.slice(0, 254), i] as const).reverse());
  return results.sort((a, b) => (order.get(a.email) ?? 0) - (order.get(b.email) ?? 0));
}

/**
 * Runs straight after the owner's recap: with "Send to attendees
 * automatically" on, the calendar guests the scope allows get the notes.
 * Named speakers have no address, so they are never sent to automatically.
 */
export async function autoSendMeetingNotes(db: AppDb, env: RecapEnv, meetingId: string) {
  if (!emailConfigured(env)) return;
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete') return;
  const user = (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  if (!user || user.isAnonymous || !user.shareNotesAuto) return;
  const recipients = (await meetingAttendees(db, meeting, user.email)).flatMap((a) => (a.email ? [a.email] : []));
  if (!recipients.length) return;
  await queueMeetingNotes(db, env, { user, meeting, recipients });
}

export interface NotesContent {
  ownerName: string;
  title: string;
  startedAt: number | null;
  tldr: string;
  decisions: Decision[];
  actionItems: ActionItem[];
  shareLink: string;
  note?: string | null;
  attachmentNote?: string | null;
}

/** The email an attendee gets: the owner's note, the summary, action items and a link. */
export function renderMeetingNotes(content: NotesContent) {
  const subject = `Notes: ${content.title}`.slice(0, 200);
  const when = content.startedAt
    ? new Date(content.startedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC'
    : null;
  const decisions = content.decisions.map((d) => d.text).filter(Boolean);
  const actions = content.actionItems.filter((a) => a.text).map((a) => {
    const meta = [a.owner, a.due && `due ${a.due}`].filter(Boolean).join(', ');
    return { text: a.text, meta };
  });
  const tldr = content.tldr || 'No summary was written for this meeting.';
  const from = `${content.ownerName} shared these notes with you from Eavesy.`;

  const text = [
    ...(content.note ? [content.note, ''] : []),
    content.title,
    when,
    '',
    'Summary',
    tldr,
    ...(actions.length ? ['', 'Action items', ...actions.map((a) => `- ${a.text}${a.meta ? ` (${a.meta})` : ''}`)] : []),
    ...(decisions.length ? ['', 'Decisions', ...decisions.map((d) => `- ${d}`)] : []),
    '',
    `Full notes: ${content.shareLink}`,
    ...(content.attachmentNote ? [content.attachmentNote] : []),
    '',
    from,
  ].filter((line) => line !== null).join('\n');

  const section = (heading: string, items: string[]) => items.length
    ? `<h2 style="font-size:15px;margin:24px 0 8px">${heading}</h2><ul style="margin:0;padding-left:20px">${items.map((i) => `<li style="margin:4px 0">${i}</li>`).join('')}</ul>`
    : '';
  const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#16213f;line-height:1.5;max-width:600px;margin:0 auto;padding:24px">
${content.note ? `<p style="margin:0 0 24px;white-space:pre-wrap">${escapeHtml(content.note)}</p>` : ''}
<h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(content.title)}</h1>
${when ? `<p style="color:#505a75;margin:0 0 16px;font-size:13px">${escapeHtml(when)}</p>` : ''}
<h2 style="font-size:15px;margin:24px 0 8px">Summary</h2>
<p style="margin:0">${escapeHtml(tldr)}</p>
${section('Action items', actions.map((a) => `${escapeHtml(a.text)}${a.meta ? ` <span style="color:#505a75">(${escapeHtml(a.meta)})</span>` : ''}`))}
${section('Decisions', decisions.map(escapeHtml))}
<p style="margin:24px 0 0"><a href="${escapeHtml(content.shareLink)}" style="color:#16213f">Open the full notes</a></p>
${content.attachmentNote ? `<p style="color:#505a75;font-size:13px">${escapeHtml(content.attachmentNote)}</p>` : ''}
<p style="color:#666d85;font-size:12px;margin-top:32px">${escapeHtml(from)}</p>
</body></html>`;
  return { subject, html, text };
}

/**
 * Queue job: sends every queued `meeting_notes` delivery of a meeting. Safe to
 * run again: `deliver` only ever sends a row still `queued`. The transcript is
 * attached only while the owner's "Include the transcript" setting is on.
 */
export async function sendMeetingNotes(db: AppDb, env: RecapEnv, meetingId: string) {
  if (!emailConfigured(env)) return;
  const pending = await db.select().from(emailDeliveries)
    .where(and(eq(emailDeliveries.meetingId, meetingId), eq(emailDeliveries.kind, 'meeting_notes'), eq(emailDeliveries.status, 'queued')));
  if (!pending.length) return;
  const meeting = (await db.select().from(meetings).where(eq(meetings.id, meetingId)).limit(1))[0];
  const user = meeting && (await db.select().from(users).where(eq(users.id, meeting.userId)).limit(1))[0];
  if (!meeting || meeting.deletedAt || meeting.status !== 'complete' || !user || user.isAnonymous) {
    await db.update(emailDeliveries).set({ status: 'failed', statusDetail: 'meeting_gone', updatedAt: Date.now() })
      .where(and(inArray(emailDeliveries.id, pending.map((d) => d.id)), eq(emailDeliveries.status, 'queued')));
    return;
  }

  const summary = (await db.select().from(summaries).where(eq(summaries.meetingId, meetingId)).limit(1))[0];
  const { attachments, attachmentNote } = user.emailRecapTranscript
    ? await transcriptFiles(db, meeting)
    : { attachments: [], attachmentNote: null };
  // Renews the link only when it has already expired, so earlier emails never lose a working link.
  const slug = await ensureShareLink(db, meeting);
  const blocked = await suppressedAmong(db, pending.map((d) => d.recipient), user.id);
  const ownerName = user.displayName?.trim() || recipientAddress(user.email) || 'Someone';
  const base = {
    ownerName,
    title: meeting.title,
    startedAt: meeting.startedAt,
    tldr: summary?.tldr ?? '',
    decisions: decode<Decision[]>(summary?.decisionsJson, []),
    actionItems: decode<ActionItem[]>(summary?.actionItemsJson, []),
    shareLink: `${appUrl(env)}/share/${encodeURIComponent(slug)}`,
    attachmentNote,
  };

  for (const delivery of pending) {
    // The owner's settings may have changed since this was queued.
    if (!recipientAllowed(user.shareNotesScope, user.email, delivery.recipient)) {
      await db.update(emailDeliveries).set({ status: 'failed', statusDetail: 'not_allowed', updatedAt: Date.now() })
        .where(and(eq(emailDeliveries.id, delivery.id), eq(emailDeliveries.status, 'queued')));
      continue;
    }
    if (blocked.has(delivery.recipient)) {
      await db.update(emailDeliveries).set({ status: 'failed', statusDetail: 'suppressed_recipient', updatedAt: Date.now() })
        .where(and(eq(emailDeliveries.id, delivery.id), eq(emailDeliveries.status, 'queued')));
      continue;
    }
    const rendered = renderMeetingNotes({ ...base, note: delivery.note });
    await deliver(db, env, delivery, { to: delivery.recipient, ...rendered, attachments });
  }
}

/** What the confirm page shows: who was there, who already has the notes, and what they'd get. */
export async function shareOverview(db: AppDb, env: RecapEnv, user: User, meeting: Meeting) {
  const [attendees, sent, summary] = await Promise.all([
    meetingAttendees(db, meeting, user.email),
    db.select({ recipient: emailDeliveries.recipient, status: emailDeliveries.status }).from(emailDeliveries)
      .where(and(eq(emailDeliveries.meetingId, meeting.id), eq(emailDeliveries.kind, 'meeting_notes'))),
    db.select().from(summaries).where(eq(summaries.meetingId, meeting.id)).limit(1).then((rows) => rows[0]),
  ]);
  const statusBy = new Map(sent.map((row) => [row.recipient, row.status]));
  const blocked = await suppressedAmong(db, [...attendees.flatMap((a) => (a.email ? [a.email] : [])), ...sent.map((row) => row.recipient)], user.id);
  const rows = attendees.map((a) => ({
    ...a,
    external: a.email ? isExternal(user.email, a.email) : false,
    allowed: a.email ? recipientAllowed(user.shareNotesScope, user.email, a.email) : true,
    suppressed: a.email ? blocked.has(a.email) : false,
    status: a.email ? statusBy.get(a.email) ?? null : null,
  }));
  // People added by hand on an earlier send.
  const listed = new Set(attendees.map((a) => a.email));
  const added = sent.filter((row) => !listed.has(row.recipient)).map((row) => ({
    email: row.recipient,
    name: null,
    source: 'added' as const,
    external: isExternal(user.email, row.recipient),
    allowed: recipientAllowed(user.shareNotesScope, user.email, row.recipient),
    suppressed: blocked.has(row.recipient),
    status: row.status,
  }));
  return {
    configured: emailConfigured(env),
    meeting: { id: meeting.id, title: meeting.title, startedAt: meeting.startedAt, status: meeting.status },
    owner: { email: recipientAddress(user.email), name: user.displayName ?? null, companyDomain: companyDomain(user.email) },
    settings: { offer: user.shareNotesOffer, scope: user.shareNotesScope, includeTranscript: user.emailRecapTranscript },
    preview: {
      tldr: summary?.tldr ?? '',
      decisions: decode<Decision[]>(summary?.decisionsJson, []).map((d) => d.text).filter(Boolean),
      actionItems: decode<ActionItem[]>(summary?.actionItemsJson, []).filter((a) => a.text)
        .map((a) => ({ text: a.text, owner: a.owner ?? null, due: a.due ?? null })),
    },
    attendees: [...rows, ...added],
  };
}
