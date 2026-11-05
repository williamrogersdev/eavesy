import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MessageBatch } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import type { ProcessingMessage } from '@/server/processing-worker';
import { createFakeEnv, delivery } from '@/server/testing/fake-env';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { queue } = await import('@/server/processing-worker');
const { ensureClerkUser } = await import('@/db/repo/users');
const { AUTO_ENABLED_NOTICE, applyEmailEvent, sendRecap, turnOffRecapsByToken } = await import('./recaps');
const {
  autoSendMeetingNotes,
  companyDomain,
  meetingAttendees,
  queueMeetingNotes,
  recipientAllowed,
  sendMeetingNotes,
  shareOverview,
  MAX_NOTE_RECIPIENTS_PER_DAY,
  MAX_ADDED_RECIPIENTS,
} = await import('./meeting-notes');

const MIGRATIONS = join(import.meta.dir, '../../../drizzle');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { to: string[]; subject: string; html: string; text: string; attachments?: { filename: string }[]; tags: { name: string; value: string }[] }

function mockResend(reject: (call: Call) => boolean = () => false) {
  const calls: (Call & { key: string })[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const call = { ...(JSON.parse(String(init?.body ?? '{}')) as Call), key: new Headers(init?.headers).get('idempotency-key') ?? '' };
    calls.push(call);
    if (reject(call)) return Response.json({ name: 'validation_error' }, { status: 422 });
    return Response.json({ id: `re_${calls.length}` });
  }) as typeof fetch;
  return calls;
}

function setup(opts: { email?: string; scope?: 'everyone' | 'domain'; transcript?: boolean; auto?: boolean; offer?: boolean; event?: boolean } = {}) {
  const t = createFakeEnv();
  const now = Date.now();
  t.sqlite.run(
    `INSERT INTO users (id, email, display_name, email_recaps, email_recap_transcript, share_notes_scope, share_notes_auto, share_notes_offer, created_at, updated_at)
     VALUES ('u1', ?, 'Owen Owner', 1, ?, ?, ?, ?, ?, ?)`,
    [opts.email ?? 'owner@acme.com', opts.transcript ? 1 : 0, opts.scope ?? 'everyone', opts.auto ? 1 : 0, opts.offer === false ? 0 : 1, now, now],
  );
  t.sqlite.run(`INSERT INTO calendar_connections (id, user_id, provider, account_email, refresh_token_encrypted) VALUES ('c1', 'u1', 'google', 'owner@acme.com', 'sealed')`);
  if (opts.event !== false) {
    t.sqlite.run(
      `INSERT INTO calendar_events (id, user_id, connection_id, provider_event_id, title, starts_at, ends_at, participants_json)
       VALUES ('e1', 'u1', 'c1', 'g1', 'Launch', ?, ?, ?)`,
      [now, now, JSON.stringify([
        { email: 'Owner@Acme.com', name: 'Owen' },
        { email: 'bea@acme.com', name: 'Bea' },
        { email: 'cy@partner.io', name: null },
        { email: 'bea@acme.com', name: 'Bea again' },
      ])],
    );
  }
  t.sqlite.run(
    `INSERT INTO meetings (id, user_id, title, started_at, source, status, calendar_event_id, speaker_names_json, created_at, updated_at)
     VALUES ('m1', 'u1', 'Launch sync', ?, 'desktop', 'complete', ?, '{"speaker_1":"Ana Ruiz","speaker_2":"Ben"}', ?, ?)`,
    [now, opts.event === false ? null : 'e1', now, now],
  );
  t.sqlite.run(
    `INSERT INTO summaries (id, meeting_id, tldr, decisions_json, action_items_json, generated_by_model, generated_at)
     VALUES ('s1', 'm1', 'Ship Friday.', '[{"text":"Ship Friday"}]', '[{"text":"Write notes","owner":"Maya","completed":false}]', 'test', ?)`,
    [now],
  );
  t.sqlite.run(`INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES ('l1', 'm1', 0, 1000, 'speaker_1', 'We ship Friday.')`);
  const env = Object.assign(t.env, {
    RESEND_API_KEY: 're_test',
    RESEND_WEBHOOK_SECRET: 'whsec_dGVzdA==',
    EMAIL_FROM: 'Eavesy <notes@example.com>',
    APP_URL: 'https://app.example.com',
  });
  const db = drizzle(t.env.DB, { schema });
  const user = async () => (await db.select().from(schema.users).where(eq(schema.users.id, 'u1')))[0];
  const meeting = async () => (await db.select().from(schema.meetings).where(eq(schema.meetings.id, 'm1')))[0];
  const rows = (kind = 'meeting_notes') => t.sqlite.query('SELECT * FROM email_deliveries WHERE kind = ? ORDER BY recipient').all(kind) as Record<string, unknown>[];
  return { ...t, env, db, user, meeting, rows };
}

async function run(env: Parameters<typeof queue>[1], body: ProcessingMessage) {
  const d = delivery(body, 1);
  await queue({ messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>, env);
  return d.outcome;
}

describe('default-on recaps migration', () => {
  /** Applies every migration before 0049, inserts accounts, then applies 0049 and the rest. */
  function migrate(seed: (db: Database) => void) {
    const db = new Database(':memory:');
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
    const apply = (file: string) => {
      for (const chunk of readFileSync(join(MIGRATIONS, file), 'utf8').split('--> statement-breakpoint')) if (chunk.trim()) db.exec(chunk);
    };
    for (const file of files.filter((f) => f < '0049')) apply(file);
    seed(db);
    for (const file of files.filter((f) => f >= '0049')) apply(file);
    return db.query('SELECT id, email_recaps, email_recaps_off_reason, email_recaps_notice_pending, email_recaps_auto_enabled_at FROM users ORDER BY id').all() as {
      id: string; email_recaps: number; email_recaps_off_reason: string | null; email_recaps_notice_pending: number; email_recaps_auto_enabled_at: number | null;
    }[];
  }

  test('switches existing accounts on once, except those turned off by the owner or a spam complaint', () => {
    const users = migrate((db) => {
      const user = (id: string, recaps: number, email: string | null = `${id}@example.com`, anonymous = 0) =>
        db.run(`INSERT INTO users (id, email, email_recaps, is_anonymous, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`, [id, email, recaps, anonymous]);
      const sent = (userId: string, status: string) =>
        db.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at)
                VALUES (?, ?, 'meeting_recap', 'x@example.com', ?, 'resend', ?, 1, 1)`, [`eml_${userId}_${status}`, userId, `k_${userId}_${status}`, status]);
      user('a_never', 0);
      user('b_already_on', 1);
      user('c_turned_off', 0);
      sent('c_turned_off', 'delivered');
      user('d_complained', 0);
      sent('d_complained', 'delivered');
      sent('d_complained', 'complained');
      user('e_anonymous', 0, null, 1);
      user('f_no_email', 0, null);
      // Saved a setting after recaps shipped: may have turned them off before getting one.
      user('g_saved_settings', 0);
      db.run(`INSERT INTO activity_log (id, user_id, event_type, created_at) VALUES ('act_g', 'g_saved_settings', 'settings.update', 1792637733902)`);
      user('h_saved_long_ago', 0);
      db.run(`INSERT INTO activity_log (id, user_id, event_type, created_at) VALUES ('act_h', 'h_saved_long_ago', 'settings.update', 1792637733901)`);
    });
    const by = Object.fromEntries(users.map((u) => [u.id, u]));
    expect(by.a_never).toMatchObject({ email_recaps: 1, email_recaps_off_reason: null, email_recaps_notice_pending: 1 });
    expect(by.a_never.email_recaps_auto_enabled_at).toBeGreaterThan(Date.now() - 60_000);
    expect(by.b_already_on).toMatchObject({ email_recaps: 1, email_recaps_notice_pending: 0, email_recaps_auto_enabled_at: null });
    expect(by.c_turned_off).toMatchObject({ email_recaps: 0, email_recaps_off_reason: 'user', email_recaps_notice_pending: 0 });
    expect(by.d_complained).toMatchObject({ email_recaps: 0, email_recaps_off_reason: 'complaint', email_recaps_notice_pending: 0 });
    expect(by.e_anonymous).toMatchObject({ email_recaps: 0, email_recaps_notice_pending: 0 });
    expect(by.f_no_email).toMatchObject({ email_recaps: 0, email_recaps_notice_pending: 0 });
    expect(by.g_saved_settings).toMatchObject({ email_recaps: 0, email_recaps_notice_pending: 0 });
    expect(by.h_saved_long_ago).toMatchObject({ email_recaps: 1, email_recaps_notice_pending: 1 });
  });

  test('new accounts start with recaps on and the other email settings at their defaults', async () => {
    const t = setup();
    const created = await ensureClerkUser(t.db, { clerkUserId: 'clerk_new', email: 'new@acme.com' });
    expect(created).toMatchObject({ emailRecaps: true, shareNotesOffer: true, shareNotesScope: 'everyone', shareNotesAuto: false, emailRecapsNoticePending: false });
  });
});

describe('recap to the owner', () => {
  test('an account switched on by the migration is told once, with a link that turns recaps off on POST', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE users SET email_recaps_notice_pending = 1, email_recaps_auto_enabled_at = 1 WHERE id = 'u1'`);
    const calls = mockResend();
    expect(await sendRecap(t.db, t.env, 'm1')).toBe('recapped');
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain(AUTO_ENABLED_NOTICE);
    const link = /Turn them off: (\S+)/.exec(calls[0].text)?.[1] ?? '';
    expect(link).toMatch(/^https:\/\/app\.example\.com\/recaps\/off\/[A-Za-z0-9_-]{16,}$/);
    expect((await t.user()).emailRecapsNoticePending).toBe(false);

    // The next recap doesn't say it again.
    t.sqlite.run(`INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at) VALUES ('m2', 'u1', 'Next', 1, 'desktop', 'complete', 1, 1)`);
    await sendRecap(t.db, t.env, 'm2');
    expect(calls[1].text).not.toContain(AUTO_ENABLED_NOTICE);

    expect(await turnOffRecapsByToken(t.db, 'not-the-right-token-at-all')).toBe(false);
    expect(await turnOffRecapsByToken(t.db, link.split('/').pop()!)).toBe(true);
    expect(await t.user()).toMatchObject({ emailRecaps: false, emailRecapsOffReason: 'user' });
  });

  test('carries the "Send to everyone" button only while the setting is on', async () => {
    const on = setup();
    const calls = mockResend();
    await sendRecap(on.db, on.env, 'm1');
    expect(calls[0].html).toContain('https://app.example.com/app/meetings/m1/share-notes');
    expect(calls[0].html).toContain('Send to everyone');

    const off = setup({ offer: false });
    await sendRecap(off.db, off.env, 'm1');
    expect(calls[1].html).not.toContain('share-notes');
  });

  test('a spam complaint about a recap turns recaps off and records why; an attendee complaint does not', async () => {
    const t = setup();
    mockResend();
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    await sendMeetingNotes(t.db, t.env, 'm1');
    const [attendee] = await t.db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.kind, 'meeting_notes'));
    await applyEmailEvent(t.db, attendee, { type: 'email.complained', emailId: null, deliveryId: attendee.id, bounceType: null, at: Date.now() });
    expect((await t.user()).emailRecaps).toBe(true);

    await sendRecap(t.db, t.env, 'm1');
    const [recap] = await t.db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.kind, 'meeting_recap'));
    await applyEmailEvent(t.db, recap, { type: 'email.complained', emailId: null, deliveryId: recap.id, bounceType: null, at: Date.now() });
    expect(await t.user()).toMatchObject({ emailRecaps: false, emailRecapsOffReason: 'complaint' });
  });
});

describe('attendees', () => {
  test('come from the calendar event, without the owner or duplicates', async () => {
    const t = setup();
    expect(await meetingAttendees(t.db, await t.meeting(), 'owner@acme.com')).toEqual([
      { email: 'bea@acme.com', name: 'Bea', source: 'calendar' },
      { email: 'cy@partner.io', name: null, source: 'calendar' },
    ]);
  });

  test('fall back to the named speakers when there is no event', async () => {
    const t = setup({ event: false });
    expect(await meetingAttendees(t.db, await t.meeting(), 'owner@acme.com')).toEqual([
      { email: null, name: 'Ana Ruiz', source: 'speaker' },
      { email: null, name: 'Ben', source: 'speaker' },
    ]);
  });

  test('"only my company\'s domain" allows the owner\'s domain, and nobody for a personal address', () => {
    expect(recipientAllowed('everyone', 'owner@acme.com', 'cy@partner.io')).toBe(true);
    expect(recipientAllowed('domain', 'owner@acme.com', 'bea@acme.com')).toBe(true);
    expect(recipientAllowed('domain', 'owner@acme.com', 'cy@partner.io')).toBe(false);
    expect(recipientAllowed('domain', 'owner@acme.com', 'bea@sub.acme.com')).toBe(false);
    expect(companyDomain('me@gmail.com')).toBeNull();
    expect(recipientAllowed('domain', 'me@gmail.com', 'friend@gmail.com')).toBe(false);
  });

  test('the overview marks external, already-sent and not-allowed people', async () => {
    const t = setup({ scope: 'domain' });
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    const overview = await shareOverview(t.db, t.env, await t.user(), await t.meeting());
    expect(overview.attendees.map((a) => [a.email, a.external, a.allowed, a.status])).toEqual([
      ['bea@acme.com', false, true, 'queued'],
      ['cy@partner.io', true, false, null],
    ]);
    expect(overview.preview.tldr).toBe('Ship Friday.');
    // Opening the page sent nothing new.
    expect(t.sent.filter((m) => m.body.kind === 'send-meeting-notes')).toHaveLength(1);
  });
});

describe('sending notes to attendees', () => {
  test('queues each allowed recipient once and sends them with a share link', async () => {
    const t = setup();
    const calls = mockResend();
    const results = await queueMeetingNotes(t.db, t.env, {
      user: await t.user(),
      meeting: await t.meeting(),
      recipients: ['Bea@acme.com', 'bea@acme.com', 'cy@partner.io', 'owner@acme.com', 'not an address'],
      note: '  Thanks all  ',
    });
    expect(results).toEqual([
      { email: 'bea@acme.com', outcome: 'queued' },
      { email: 'cy@partner.io', outcome: 'queued' },
      { email: 'owner@acme.com', outcome: 'owner' },
      { email: 'not an address', outcome: 'invalid' },
    ]);
    expect(t.sent.map((m) => m.body)).toEqual([{ kind: 'send-meeting-notes', meetingId: 'm1' }]);

    expect(await run(t.env, { kind: 'send-meeting-notes', meetingId: 'm1' })).toEqual({ acked: true, retried: false });
    expect(calls.map((c) => c.to[0])).toEqual(['bea@acme.com', 'cy@partner.io']);
    const slug = (await t.meeting()).shareSlug;
    expect(slug).toBeTruthy();
    expect(calls[0].subject).toBe('Notes: Launch sync');
    expect(calls[0].text.startsWith('Thanks all')).toBe(true);
    expect(calls[0].text).toContain(`https://app.example.com/share/${slug}`);
    expect(calls[0].text).toContain('- Write notes (Maya)');
    expect(calls[0].text).toContain('Owen Owner shared these notes');
    expect(calls[0].attachments).toBeUndefined();
    expect(calls[0].tags).toContainEqual({ name: 'kind', value: 'meeting_notes' });
    expect(t.rows().map((r) => r.status)).toEqual(['sent', 'sent']);

    // Pressing Send again, or the job running twice, sends nothing more.
    const again = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    expect(again).toEqual([{ email: 'bea@acme.com', outcome: 'already_sent' }]);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls).toHaveLength(2);
    expect(t.sent).toHaveLength(1);
  });

  test('attaches the transcript only while "Include the transcript" is on', async () => {
    const t = setup({ transcript: true });
    const calls = mockResend();
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls[0].attachments?.map((a) => a.filename)).toEqual(['transcript.txt']);
  });

  test('domain-only keeps notes inside the company, even if the setting changes after queueing', async () => {
    const t = setup();
    const calls = mockResend();
    t.sqlite.run(`UPDATE users SET share_notes_scope = 'domain' WHERE id = 'u1'`);
    const results = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(results.map((r) => r.outcome)).toEqual(['queued', 'not_allowed']);

    // Queued under "everyone", sent after switching to domain-only.
    t.sqlite.run(`UPDATE users SET share_notes_scope = 'everyone' WHERE id = 'u1'`);
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['cy@partner.io'] });
    t.sqlite.run(`UPDATE users SET share_notes_scope = 'domain' WHERE id = 'u1'`);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls.map((c) => c.to[0])).toEqual(['bea@acme.com']);
    expect(t.rows().map((r) => [r.recipient, r.status, r.status_detail])).toEqual([
      ['bea@acme.com', 'sent', null],
      ['cy@partner.io', 'failed', 'not_allowed'],
    ]);
  });

  test('skips addresses that bounced for good or complained before', async () => {
    const t = setup();
    const calls = mockResend();
    t.sqlite.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, status_detail, created_at, updated_at)
                  VALUES ('old', 'u1', 'meeting_notes', 'cy@partner.io', 'old', 'resend', 'bounced', 'permanent', 1, 1)`);
    const results = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(results.map((r) => r.outcome)).toEqual(['queued', 'suppressed']);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls.map((c) => c.to[0])).toEqual(['bea@acme.com']);
  });

  test('"Send to attendees automatically" sends straight after the owner\'s recap, and only when on', async () => {
    const off = setup();
    const calls = mockResend();
    await run(off.env, { kind: 'send-recap', meetingId: 'm1' });
    expect(off.rows()).toHaveLength(0);

    const on = setup({ auto: true, scope: 'domain' });
    await run(on.env, { kind: 'send-recap', meetingId: 'm1' });
    expect(on.rows().map((r) => r.recipient)).toEqual(['bea@acme.com']);
    expect(on.sent.map((m) => m.body)).toEqual([{ kind: 'send-meeting-notes', meetingId: 'm1' }]);
    await run(on.env, { kind: 'send-meeting-notes', meetingId: 'm1' });
    expect(calls.map((c) => c.to[0])).toEqual(['owner@acme.com', 'owner@acme.com', 'bea@acme.com']);

    // A retried recap job doesn't queue anyone twice.
    await autoSendMeetingNotes(on.db, on.env, 'm1');
    expect(on.rows()).toHaveLength(1);
  });
});

describe('review fixes', () => {
  test('a send that certainly failed can be sent again; one that went out cannot', async () => {
    const t = setup();
    const calls = mockResend((call) => call.to[0] === 'bea@acme.com' && calls.length === 1);
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(t.rows().map((r) => r.status)).toEqual(['failed']);

    const again = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    expect(again).toEqual([{ email: 'bea@acme.com', outcome: 'queued' }]);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(t.rows().map((r) => r.status)).toEqual(['sent']);
    // The second attempt uses its own provider key, so the provider doesn't drop it as a repeat.
    expect(calls.map((c) => c.key)).toEqual([String(t.rows()[0].id), `${String(t.rows()[0].id)}:2`]);
    expect((await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] }))[0].outcome).toBe('already_sent');
  });

  test("another account's spam complaint doesn't block this owner's notes; a permanent bounce does", async () => {
    const t = setup();
    t.sqlite.run(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'someone@else.com', 1, 1)`);
    t.sqlite.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at)
                  VALUES ('c', 'u2', 'meeting_notes', 'bea@acme.com', 'c', 'resend', 'complained', 1, 1),
                         ('b', 'u2', 'meeting_notes', 'cy@partner.io', 'b', 'resend', 'bounced', 1, 1)`);
    t.sqlite.run(`UPDATE email_deliveries SET status_detail = 'permanent' WHERE id = 'b'`);
    const results = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(results.map((r) => r.outcome)).toEqual(['queued', 'suppressed']);
  });

  test("no automatic sending while the owner's own recap failed", async () => {
    const t = setup({ auto: true });
    mockResend(() => true);
    await run(t.env, { kind: 'send-recap', meetingId: 'm1' });
    expect(t.rows('meeting_recap').map((r) => r.status)).toEqual(['failed']);
    expect(t.rows()).toHaveLength(0);
    await run(t.env, { kind: 'send-recap', meetingId: 'm1' });
    expect(t.rows()).toHaveLength(0);
  });

  test('the migration notice survives a rejected recap, and the off link works once', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE users SET email_recaps_notice_pending = 1 WHERE id = 'u1'`);
    mockResend(() => true);
    await sendRecap(t.db, t.env, 'm1');
    expect((await t.user()).emailRecapsNoticePending).toBe(true);
    const token = (await t.user()).emailRecapsOffToken!;
    expect(await turnOffRecapsByToken(t.db, token)).toBe(true);
    expect(await turnOffRecapsByToken(t.db, token)).toBe(false);
  });

  test('each account emails at most MAX_NOTE_RECIPIENTS_PER_DAY people a day', async () => {
    const t = setup();
    const now = Date.now();
    for (let i = 0; i < MAX_NOTE_RECIPIENTS_PER_DAY - 1; i++) {
      t.sqlite.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at)
                    VALUES (?, 'u1', 'meeting_notes', ?, ?, 'resend', 'sent', ?, ?)`, [`d${i}`, `p${i}@x.com`, `k${i}`, now, now]);
    }
    const results = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(results.map((r) => r.outcome)).toEqual(['queued', 'daily_limit']);
  });

  test('queued notes for a meeting that is no longer complete are not sent', async () => {
    const t = setup();
    const calls = mockResend();
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    t.sqlite.run(`UPDATE meetings SET status = 'processing' WHERE id = 'm1'`);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls).toHaveLength(0);
    expect(t.rows().map((r) => r.status)).toEqual(['failed']);
  });
});

describe('review round 2', () => {
  test('a soft bounce can be sent again; a complaint about this owner cannot', async () => {
    const t = setup();
    const calls = mockResend();
    await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    await sendMeetingNotes(t.db, t.env, 'm1');
    t.sqlite.run(`UPDATE email_deliveries SET status = 'bounced', status_detail = 'transient', created_at = 1 WHERE recipient = 'bea@acme.com'`);
    t.sqlite.run(`UPDATE email_deliveries SET status = 'complained' WHERE recipient = 'cy@partner.io'`);
    const again = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(again).toEqual([{ email: 'bea@acme.com', outcome: 'queued' }, { email: 'cy@partner.io', outcome: 'suppressed' }]);
    const bea = t.rows().find((r) => r.recipient === 'bea@acme.com')!;
    expect(bea).toMatchObject({ status: 'queued', provider_message_id: null });
    expect(Number(bea.created_at)).toBeGreaterThan(Date.now() - 60_000);
    await sendMeetingNotes(t.db, t.env, 'm1');
    expect(calls.map((c) => c.to[0])).toEqual(['bea@acme.com', 'cy@partner.io', 'bea@acme.com']);
  });

  test("another account's complaint about the owner's address doesn't stop the owner's recap", async () => {
    const t = setup();
    const calls = mockResend();
    t.sqlite.run(`INSERT INTO users (id, email, created_at, updated_at) VALUES ('u2', 'someone@else.com', 1, 1)`);
    t.sqlite.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at)
                  VALUES ('c', 'u2', 'meeting_notes', 'owner@acme.com', 'c', 'resend', 'complained', 1, 1)`);
    expect(await sendRecap(t.db, t.env, 'm1')).toBe('recapped');
    expect(calls).toHaveLength(1);
  });

  test("the daily cap counts sends made in the last day, not old ones updated today", async () => {
    const t = setup();
    const now = Date.now();
    for (let i = 0; i < MAX_NOTE_RECIPIENTS_PER_DAY; i++) {
      t.sqlite.run(`INSERT INTO email_deliveries (id, user_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at)
                    VALUES (?, 'u1', 'meeting_notes', ?, ?, 'resend', 'delivered', ?, ?)`, [`d${i}`, `p${i}@x.com`, `k${i}`, now - 2 * 86_400_000, now]);
    }
    const results = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com'] });
    expect(results[0].outcome).toBe('queued');
  });

  test('people who were not in the meeting need the owner to confirm them, and only a few per send', async () => {
    const t = setup();
    const extra = Array.from({ length: MAX_ADDED_RECIPIENTS + 1 }, (_, i) => `x${i}@else.com`);
    const unconfirmed = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: ['bea@acme.com', 'x0@else.com'] });
    expect(unconfirmed).toEqual([{ email: 'bea@acme.com', outcome: 'queued' }, { email: 'x0@else.com', outcome: 'needs_confirmation' }]);
    const confirmed = await queueMeetingNotes(t.db, t.env, { user: await t.user(), meeting: await t.meeting(), recipients: extra, confirmAdded: true });
    expect(confirmed.filter((r) => r.outcome === 'queued')).toHaveLength(MAX_ADDED_RECIPIENTS);
    expect(confirmed.at(-1)).toEqual({ email: `x${MAX_ADDED_RECIPIENTS}@else.com`, outcome: 'too_many_added' });
  });
});
