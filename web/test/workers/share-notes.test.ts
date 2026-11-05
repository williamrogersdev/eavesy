import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as shareNotesRoute } from '../../src/routes/api/meetings/$id/share-notes';
import { Route as shareRoute } from '../../src/routes/api/share/$slug';
import { Route as recapsOffRoute } from '../../src/routes/api/email/recaps-off';
import { Route as meRoute } from '../../src/routes/api/me';
import { ensureClerkUser } from '../../src/db/repo/users';
import { getDb } from '../../src/db/client';
import { handler, insertMeeting, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
const queued = vi.hoisted(() => ({ messages: [] as { kind: string; meetingId?: string }[] }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
}));
// Email is configured, and the queue is recorded instead of run.
vi.mock('../../src/server/cloudflare-context', async () => {
  const { env } = await import('cloudflare:workers');
  const withEmail = Object.create(env as object, {
    RESEND_API_KEY: { value: 're_test' },
    RESEND_WEBHOOK_SECRET: { value: 'whsec_dGVzdA==' },
    EMAIL_FROM: { value: 'Eavesy <notes@example.com>' },
    PROCESSING_QUEUE: { value: { send: async (message: { kind: string; meetingId?: string }) => { queued.messages.push(message); } } },
  }) as unknown;
  return { getCloudflareContext: () => ({ env: withEmail }) };
});

const getOverview = handler(shareNotesRoute, 'GET');
const postSend = handler(shareNotesRoute, 'POST');
const getShare = handler(shareRoute, 'GET');
const postOff = handler(recapsOffRoute, 'POST');
const getMe = handler(meRoute, 'GET');
const patchMe = handler(meRoute, 'PATCH');

const OWNER = 'user_share_owner';
const OTHER = 'user_share_other';
const MEETING = 'meet_share';
const params = { id: MEETING };

function send(body: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return postSend({
    request: new Request(`https://eavesy.test/api/meetings/${MEETING}/share-notes`, { method: 'POST', headers, body: JSON.stringify(body) }),
    params,
  });
}

async function deliveries() {
  const { results } = await testEnv.DB.prepare(`SELECT recipient, kind, status FROM email_deliveries WHERE kind = 'meeting_notes' ORDER BY recipient`).all();
  return results;
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  actor.userId = null;
  queued.messages = [];
  await resetTables('email_deliveries', 'rate_limits', 'activity_log', 'summaries', 'calendar_events', 'calendar_connections', 'meetings', 'users');
  const now = Date.now();
  for (const [id, email] of [[OWNER, 'owner@acme.com'], [OTHER, 'other@acme.com']]) {
    await testEnv.DB.prepare(
      `INSERT INTO users (id, email, email_recaps, default_transcription_engine, default_language, is_anonymous, created_at, updated_at)
       VALUES (?, ?, 1, 'whisper', 'en', 0, ?, ?)`,
    ).bind(id, email, now, now).run();
  }
  await insertMeeting({ id: MEETING, userId: OWNER, status: 'complete' });
  await testEnv.DB.batch([
    testEnv.DB.prepare(`INSERT INTO summaries (id, meeting_id, tldr, generated_by_model, generated_at) VALUES ('sum_share', ?, 'Ship Friday.', 'test', ?)`).bind(MEETING, now),
    testEnv.DB.prepare(`INSERT INTO calendar_connections (id, user_id, provider, account_email, refresh_token_encrypted) VALUES ('cal_share', ?, 'google', 'owner@acme.com', 'sealed')`).bind(OWNER),
    testEnv.DB.prepare(
      `INSERT INTO calendar_events (id, user_id, connection_id, provider_event_id, title, starts_at, ends_at, participants_json)
       VALUES ('evt_share', ?, 'cal_share', 'g_share', 'Launch', ?, ?, ?)`,
    ).bind(OWNER, now, now, JSON.stringify([{ email: 'owner@acme.com' }, { email: 'bea@acme.com', name: 'Bea' }, { email: 'cy@partner.io' }])),
    testEnv.DB.prepare(`UPDATE meetings SET calendar_event_id = 'evt_share' WHERE id = ?`).bind(MEETING),
  ]);
});

describe('Send to everyone', () => {
  it('opening the confirm page (a mail scanner following the link) sends nothing', async () => {
    const anonymous = await getOverview({ request: new Request('https://eavesy.test/x'), params });
    expect(anonymous.status).toBe(401);

    actor.userId = OWNER;
    const response = await getOverview({ request: new Request('https://eavesy.test/x'), params });
    expect(response.status).toBe(200);
    const body = await response.json<{ attendees: { email: string; external: boolean }[] }>();
    expect(body.attendees.map((a) => [a.email, a.external])).toEqual([['bea@acme.com', false], ['cy@partner.io', true]]);
    expect(await deliveries()).toEqual([]);
    expect(queued.messages).toEqual([]);
  });

  it('sends only on a JSON POST from the signed-in owner', async () => {
    expect((await send({ recipients: ['bea@acme.com'] })).status).toBe(401);

    actor.userId = OTHER;
    expect((await send({ recipients: ['bea@acme.com'] })).status).toBe(404);

    actor.userId = OWNER;
    // What a form on another site could send.
    expect((await send({ recipients: ['bea@acme.com'] }, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await send({ recipients: ['bea@acme.com'] }, { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(await deliveries()).toEqual([]);

    const response = await send({ recipients: ['bea@acme.com', 'cy@partner.io'], note: 'Thanks all' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ email: 'bea@acme.com', outcome: 'queued' }, { email: 'cy@partner.io', outcome: 'queued' }] });
    expect(queued.messages).toEqual([{ kind: 'send-meeting-notes', meetingId: MEETING }]);
    expect(await deliveries()).toEqual([
      { recipient: 'bea@acme.com', kind: 'meeting_notes', status: 'queued' },
      { recipient: 'cy@partner.io', kind: 'meeting_notes', status: 'queued' },
    ]);

    // Pressing Send again doesn't queue anyone twice.
    const again = await send({ recipients: ['bea@acme.com'] });
    expect(await again.json()).toEqual({ results: [{ email: 'bea@acme.com', outcome: 'already_sent' }] });
    expect(queued.messages).toHaveLength(1);
  });

  it('keeps notes inside the company when the owner chose domain-only', async () => {
    actor.userId = OWNER;
    await testEnv.DB.prepare(`UPDATE users SET share_notes_scope = 'domain' WHERE id = ?`).bind(OWNER).run();
    const response = await send({ recipients: ['bea@acme.com', 'cy@partner.io'] });
    expect(await response.json()).toEqual({ results: [{ email: 'bea@acme.com', outcome: 'queued' }, { email: 'cy@partner.io', outcome: 'not_allowed' }] });
  });

  it('is rate-limited', async () => {
    actor.userId = OWNER;
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await send({ recipients: [`p${i}@acme.com`] })).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('opens the share link the notes point at, until it expires', async () => {
    actor.userId = OWNER;
    await send({ recipients: ['bea@acme.com'] });
    const meeting = await row<{ share_slug: string }>('SELECT share_slug FROM meetings WHERE id = ?', MEETING);
    const open = await getShare({ request: new Request('https://eavesy.test/x'), params: { slug: meeting!.share_slug } });
    expect(open.status).toBe(200);
    expect(await open.json()).toMatchObject({ title: 'Test meeting', tldr: 'Ship Friday.' });

    await testEnv.DB.prepare('UPDATE meetings SET deleted_at = 1 WHERE id = ?').bind(MEETING).run();
    expect((await getShare({ request: new Request('https://eavesy.test/x'), params: { slug: meeting!.share_slug } })).status).toBe(404);

    await testEnv.DB.prepare('UPDATE meetings SET deleted_at = NULL, share_expires_at = 1 WHERE id = ?').bind(MEETING).run();
    expect((await getShare({ request: new Request('https://eavesy.test/x'), params: { slug: meeting!.share_slug } })).status).toBe(404);
  });
});

describe('Settings → Email', () => {
  it('new accounts get recaps by default, and the owner turning them off is remembered', async () => {
    const created = await ensureClerkUser(getDb(), { clerkUserId: 'clerk_share_new', email: 'new@acme.com' });
    expect(created.emailRecaps).toBe(true);

    actor.userId = OWNER;
    const patch = (body: unknown) => patchMe({
      request: new Request('https://eavesy.test/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      params: {},
    });
    expect((await patch({ emailRecaps: false, shareNotesScope: 'domain', shareNotesAuto: true, shareNotesOffer: false })).status).toBe(200);
    expect(await row('SELECT email_recaps, email_recaps_off_reason, share_notes_scope, share_notes_auto, share_notes_offer FROM users WHERE id = ?', OWNER))
      .toEqual({ email_recaps: 0, email_recaps_off_reason: 'user', share_notes_scope: 'domain', share_notes_auto: 1, share_notes_offer: 0 });
    expect((await patch({ shareNotesScope: 'nobody' })).status).toBe(400);
    const me = await (await getMe({ request: new Request('https://eavesy.test/api/me'), params: {} })).json();
    expect(me).toMatchObject({ shareNotesScope: 'domain', shareNotesAuto: true, shareNotesOffer: false, companyDomain: 'acme.com' });
  });

  it('the one-click link turns recaps off only on POST with the account’s token', async () => {
    await testEnv.DB.prepare(`UPDATE users SET email_recaps_off_token = 'tok_0123456789abcdef' WHERE id = ?`).bind(OWNER).run();
    const off = (token: string) => postOff({
      request: new Request('https://eavesy.test/api/email/recaps-off', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }),
      params: {},
    });
    expect((await off('tok_wrongwrongwrong0')).status).toBe(404);
    expect(await row('SELECT email_recaps FROM users WHERE id = ?', OWNER)).toEqual({ email_recaps: 1 });
    expect((await off('tok_0123456789abcdef')).status).toBe(200);
    expect(await row('SELECT email_recaps, email_recaps_off_reason FROM users WHERE id = ?', OWNER)).toEqual({ email_recaps: 0, email_recaps_off_reason: 'user' });
  });
});
