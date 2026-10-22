import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { MessageBatch } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '@/db/schema';
import type { ProcessingMessage } from '@/server/processing-worker';
import { createFakeEnv, delivery, stubAnthropic, summaryReply } from '@/server/testing/fake-env';
mock.module('cloudflare:workers', () => ({ env: {}, waitUntil: () => undefined }));
const { queue } = await import('@/server/processing-worker');
const { handlePurgeAccount } = await import('@/server/processing/cleanup');
const {
  RECAP_EXPIRE_AFTER_MS,
  RECAP_REQUEUE_AFTER_MS,
  failRecap,
  handleEmailWebhook,
  queueRecap,
  recipientAddress,
  reconcileRecaps,
  renderRecap,
  sendRecap,
} = await import('./recaps');

const SECRET = `whsec_${btoa('resend-signing-secret-0123456789')}`;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Call { url: string; headers: Record<string, string>; body: Record<string, unknown> }

/** Answers Resend's send endpoint with `reply`; records each call. */
function mockResend(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
}

function setup(opts: { recaps?: boolean; transcript?: boolean; email?: string | null; anonymous?: boolean } = {}) {
  const t = createFakeEnv();
  const now = Date.now();
  t.sqlite.run(
    `INSERT INTO users (id, email, is_anonymous, email_recaps, email_recap_transcript, created_at, updated_at) VALUES ('u1', ?, ?, ?, ?, ?, ?)`,
    [opts.email === undefined ? 'Owner@Example.com' : opts.email, opts.anonymous ? 1 : 0, opts.recaps === false ? 0 : 1, opts.transcript ? 1 : 0, now, now],
  );
  t.sqlite.run(
    `INSERT INTO meetings (id, user_id, title, started_at, source, status, speaker_names_json, created_at, updated_at)
     VALUES ('m1', 'u1', 'Launch <sync>', ?, 'bot', 'complete', '{"speaker_1":"Ana Ruiz"}', ?, ?)`,
    [now, now, now],
  );
  t.sqlite.run(
    `INSERT INTO summaries (id, meeting_id, tldr, decisions_json, action_items_json, generated_by_model, generated_at)
     VALUES ('s1', 'm1', 'Ship Friday & tell support.', '[{"text":"Ship Friday"}]', '[{"text":"Write notes","owner":"Maya","due":"Thu","completed":false}]', 'test', ?)`,
    [now],
  );
  t.sqlite.run(`INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, speaker_id, text) VALUES ('l1', 'm1', 65000, 66000, 'speaker_1', 'We ship Friday.')`);
  const env = Object.assign(t.env, {
    RESEND_API_KEY: 're_test',
    RESEND_WEBHOOK_SECRET: SECRET,
    EMAIL_FROM: 'Eavesy <recaps@example.com>',
    APP_URL: 'https://app.example.com/',
  });
  const db = drizzle(t.env.DB, { schema });
  const rows = () => t.sqlite.query('SELECT * FROM email_deliveries ORDER BY created_at').all() as Record<string, unknown>[];
  return { ...t, env, db, rows };
}

async function sign(body: string, id: string, at = Date.now()) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(SECRET.slice(6)), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const timestamp = String(Math.floor(at / 1000));
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}` };
}

async function webhook(t: ReturnType<typeof setup>, type: string, data: Record<string, unknown>, id = `msg_${Math.random()}`) {
  const body = JSON.stringify({ type, created_at: new Date().toISOString(), data });
  return handleEmailWebhook(t.db, t.env, new Request('https://test/api/webhooks/resend', { method: 'POST', body, headers: await sign(body, id) }));
}

async function deliver(env: Parameters<typeof queue>[1], body: ProcessingMessage, attempts = 1) {
  const d = delivery(body, attempts);
  await queue({ messages: [d.message] } as unknown as MessageBatch<ProcessingMessage>, env);
  return d.outcome;
}

describe('recap content', () => {
  test('escapes meeting text and lists the TL;DR, decisions, action items and link', () => {
    const recap = renderRecap({
      title: 'Q3 <script>',
      startedAt: Date.UTC(2026, 9, 21, 15, 0),
      tldr: 'Ship & tell',
      decisions: [{ text: 'Use "Resend"' }],
      actionItems: [{ text: 'Notes', owner: 'Maya', due: 'Thu', completed: false }],
      link: 'https://app.example.com/app/meetings/m1',
    });
    expect(recap.subject).toBe('Recap: Q3 <script>');
    expect(recap.html).not.toContain('<script>');
    expect(recap.html).toContain('Q3 &lt;script&gt;');
    expect(recap.html).toContain('Use &quot;Resend&quot;');
    expect(recap.text).toContain('- Notes (Maya, due Thu)');
    expect(recap.text).toContain('Transcript: https://app.example.com/app/meetings/m1');
  });

  test('accepts only plain addresses', () => {
    expect(recipientAddress(' Ana@Example.com ')).toBe('ana@example.com');
    expect(recipientAddress('Ana <ana@example.com>')).toBeNull();
    expect(recipientAddress('a@b.c, d@e.f')).toBeNull();
    expect(recipientAddress(null)).toBeNull();
  });
});

describe('queueing', () => {
  test('queues only for signed-in owners who turned recaps on, when the provider is configured', async () => {
    const t = setup();
    const owner = { isAnonymous: false, email: 'a@example.com', emailRecaps: true };
    await queueRecap(t.env, owner, 'm1');
    await queueRecap(t.env, { ...owner, emailRecaps: false }, 'm1');
    await queueRecap(t.env, { ...owner, isAnonymous: true }, 'm1');
    await queueRecap(t.env, { ...owner, email: null }, 'm1');
    await queueRecap({ ...t.env, RESEND_API_KEY: undefined }, owner, 'm1');
    expect(t.sent.map((m) => m.body)).toEqual([{ kind: 'send-recap', meetingId: 'm1' }]);
  });

  test('a finished summary queues the recap job instead of sending inline', async () => {
    const t = setup();
    t.sqlite.run(`UPDATE meetings SET status = 'processing' WHERE id = 'm1'`);
    const api = stubAnthropic(() => summaryReply({ title: 'Launch', description: '', tldr: 'Ship.', decisions: [], actionItems: [], followUps: [], openQuestions: [], topics: [], mentions: [] }));
    try {
      await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    } finally {
      api.restore();
    }
    expect(t.sent.map((m) => m.body.kind)).toEqual(['embed', 'agent-transcript', 'send-recap']);
    expect(t.rows()).toHaveLength(0);
  });

  test('a finished summary queues nothing with recaps off', async () => {
    const t = setup({ recaps: false });
    t.sqlite.run(`UPDATE meetings SET status = 'processing' WHERE id = 'm1'`);
    const api = stubAnthropic(() => summaryReply({ title: 'Launch', description: '', tldr: 'Ship.', decisions: [], actionItems: [], followUps: [], openQuestions: [], topics: [], mentions: [] }));
    try {
      await deliver(t.env, { kind: 'summarize', meetingId: 'm1' });
    } finally {
      api.restore();
    }
    expect(t.sent.map((m) => m.body.kind)).toEqual(['embed', 'agent-transcript']);
  });
});

describe('sending', () => {
  test('sends one email to the owner and never again for the same meeting', async () => {
    const t = setup({ transcript: true });
    const calls = mockResend(() => Response.json({ id: 're_1' }));
    await sendRecap(t.db, t.env, 'm1');
    await sendRecap(t.db, t.env, 'm1');
    await deliver(t.env, { kind: 'send-recap', meetingId: 'm1' });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe('https://api.resend.com/emails');
    expect(call.headers.authorization).toBe('Bearer re_test');
    expect(call.body.to).toEqual(['owner@example.com']);
    expect(call.body.subject).toBe('Recap: Launch <sync>');
    expect(String(call.body.html)).toContain('https://app.example.com/app/meetings/m1');
    const [row] = t.rows();
    expect(call.headers['idempotency-key']).toBe(String(row.id));
    expect(call.body.tags).toContainEqual({ name: 'eavesy_delivery', value: row.id });
    const attachments = call.body.attachments as { filename: string; content: string }[];
    expect(attachments[0].filename).toBe('transcript.txt');
    expect(new TextDecoder().decode(Uint8Array.from(atob(attachments[0].content), (c) => c.charCodeAt(0)))).toBe('[01:05] Ana Ruiz: We ship Friday.');
    expect(row).toMatchObject({
      status: 'sent',
      provider_message_id: 're_1',
      recipient: 'owner@example.com',
      idempotency_key: 'meeting_recap:m1:owner@example.com',
      attempts: 1,
    });
  });

  test('leaves the transcript out unless asked', async () => {
    const t = setup();
    const calls = mockResend(() => Response.json({ id: 're_1' }));
    await sendRecap(t.db, t.env, 'm1');
    expect(calls[0].body.attachments).toBeUndefined();
  });

  test('sends nothing for a meeting that is not complete, is deleted, or after recaps were turned off', async () => {
    const t = setup();
    const calls = mockResend(() => Response.json({ id: 're_1' }));
    t.sqlite.run(`UPDATE meetings SET status = 'processing'`);
    await sendRecap(t.db, t.env, 'm1');
    t.sqlite.run(`UPDATE meetings SET status = 'complete', deleted_at = 1`);
    await sendRecap(t.db, t.env, 'm1');
    t.sqlite.run(`UPDATE meetings SET deleted_at = NULL`);
    t.sqlite.run(`UPDATE users SET email_recaps = 0`);
    await sendRecap(t.db, t.env, 'm1');
    expect(calls).toHaveLength(0);
    expect(t.rows()).toHaveLength(0);
  });

  test('re-checks the recipient at send time: a removed address or guest account gets nothing', async () => {
    const t = setup();
    const calls = mockResend(() => Response.json({ id: 're_1' }));
    t.sqlite.run(`UPDATE users SET email = NULL`);
    await sendRecap(t.db, t.env, 'm1');
    t.sqlite.run(`UPDATE users SET email = 'owner@example.com', is_anonymous = 1`);
    await sendRecap(t.db, t.env, 'm1');
    expect(calls).toHaveLength(0);
    expect(t.rows()).toHaveLength(0);
  });

  test('a complete meeting without a summary row still sends, with a placeholder TL;DR', async () => {
    const t = setup();
    t.sqlite.run(`DELETE FROM summaries`);
    const calls = mockResend(() => Response.json({ id: 're_1' }));
    await sendRecap(t.db, t.env, 'm1');
    expect(calls).toHaveLength(1);
    expect(String(calls[0].body.text)).toContain('No summary was written for this meeting.');
    expect(t.rows()[0].status).toBe('sent');
  });

  test('a provider error keeps only its code, not the response text', async () => {
    const t = setup();
    mockResend(() => Response.json({ name: 'validation_error', message: 'Invalid `to`: owner@example.com' }, { status: 422 }));
    const logged: string[] = [];
    const original = console.error;
    console.error = (line: string) => void logged.push(line);
    try {
      await sendRecap(t.db, t.env, 'm1');
    } finally {
      console.error = original;
    }
    expect(logged.join('\n')).toContain('validation_error');
    expect(logged.join('\n')).not.toContain('owner@example.com');
    expect(t.rows()[0].status_detail).toBe('provider_rejected_422');
  });

  test('a timeout is recorded as unknown and never resent; its webhook still settles it', async () => {
    const t = setup();
    let calls = mockResend(() => { throw new DOMException('timed out', 'TimeoutError'); });
    await sendRecap(t.db, t.env, 'm1');
    expect(t.rows()[0]).toMatchObject({ status: 'unknown', status_detail: 'send_unconfirmed', provider_message_id: null });

    calls = mockResend(() => Response.json({ id: 're_2' }));
    await sendRecap(t.db, t.env, 'm1');
    await deliver(t.env, { kind: 'send-recap', meetingId: 'm1' });
    await reconcileRecaps(t.db, t.env, Date.now() + RECAP_REQUEUE_AFTER_MS * 2);
    expect(calls).toHaveLength(0);
    expect(t.sent).toHaveLength(0);

    // Resend did take it: the webhook's tag finds the row and adopts the email id.
    const id = String(t.rows()[0].id);
    expect((await webhook(t, 'email.delivered', { email_id: 're_late', tags: { eavesy_delivery: id } })).status).toBe(200);
    expect(t.rows()[0]).toMatchObject({ status: 'delivered', provider_message_id: 're_late' });
  });

  test('a 5xx or idempotency conflict is unknown, not failed', async () => {
    for (const status of [500, 409]) {
      const t = setup();
      mockResend(() => new Response('nope', { status }));
      await sendRecap(t.db, t.env, 'm1');
      expect(t.rows()[0].status).toBe('unknown');
    }
  });

  test('a rate limit goes back to queued and retries through the queue', async () => {
    const t = setup();
    let calls = mockResend(() => new Response('slow down', { status: 429 }));
    const outcome = await deliver(t.env, { kind: 'send-recap', meetingId: 'm1' });
    expect(outcome.retried).toBe(true);
    expect(t.rows()[0]).toMatchObject({ status: 'queued', status_detail: 'rate_limited', attempts: 1 });

    calls = mockResend(() => Response.json({ id: 're_3' }));
    await deliver(t.env, { kind: 'send-recap', meetingId: 'm1' }, 2);
    expect(calls).toHaveLength(1);
    expect(t.rows()[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  test('a definite rejection fails the delivery', async () => {
    const t = setup();
    mockResend(() => new Response('{"name":"validation_error"}', { status: 422 }));
    await sendRecap(t.db, t.env, 'm1');
    expect(t.rows()[0]).toMatchObject({ status: 'failed', status_detail: 'provider_rejected_422' });
  });

  test('running out of queue retries fails only a recap never attempted', async () => {
    const t = setup();
    mockResend(() => new Response('slow down', { status: 429 }));
    await deliver(t.env, { kind: 'send-recap', meetingId: 'm1' });
    await failRecap(t.db, 'm1', 'Resend returned 429');
    expect(t.rows()[0].status).toBe('failed');
  });
});

describe('delivery webhooks', () => {
  async function sent(t: ReturnType<typeof setup>) {
    mockResend(() => Response.json({ id: 're_1' }));
    await sendRecap(t.db, t.env, 'm1');
    globalThis.fetch = realFetch;
  }

  test('refuses unsigned or wrongly signed deliveries, and is off without the secret', async () => {
    const t = setup();
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 're_1' } });
    const forged = await handleEmailWebhook(t.db, t.env, new Request('https://test', { method: 'POST', body, headers: { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' } }));
    expect(forged.status).toBe(401);
    const off = await handleEmailWebhook(t.db, { ...t.env, RESEND_WEBHOOK_SECRET: undefined }, new Request('https://test', { method: 'POST', body }));
    expect(off.status).toBe(404);
  });

  test('moves forward only, and a redelivery is a no-op', async () => {
    const t = setup();
    await sent(t);
    await webhook(t, 'email.delivered', { email_id: 're_1' }, 'evt_1');
    await webhook(t, 'email.sent', { email_id: 're_1' });
    expect(t.rows()[0].status).toBe('delivered');
    const again = await webhook(t, 'email.delivered', { email_id: 're_1' }, 'evt_1');
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    await webhook(t, 'email.opened', { email_id: 're_1' });
    expect(t.rows()[0].status).toBe('delivered');
  });

  test('a delivery that fails partway is not recorded, so its retry still applies', async () => {
    const t = setup();
    await sent(t);
    t.sqlite.run('ALTER TABLE email_deliveries RENAME TO email_deliveries_hidden');
    try {
      await expect(webhook(t, 'email.delivered', { email_id: 're_1' }, 'evt_retry')).rejects.toThrow();
    } finally {
      t.sqlite.run('ALTER TABLE email_deliveries_hidden RENAME TO email_deliveries');
    }
    expect(t.sqlite.query(`SELECT id FROM provider_webhook_events WHERE id = 'resend:evt_retry'`).all()).toHaveLength(0);
    await webhook(t, 'email.delivered', { email_id: 're_1' }, 'evt_retry');
    expect(t.rows()[0].status).toBe('delivered');
  });

  test('acknowledges emails it does not know', async () => {
    const t = setup();
    const response = await webhook(t, 'email.delivered', { email_id: 're_other', tags: { eavesy_delivery: 'eml_nope' } });
    expect(response.status).toBe(200);
  });

  test('a permanent bounce stops recaps to that address', async () => {
    const t = setup();
    await sent(t);
    await webhook(t, 'email.bounced', { email_id: 're_1', bounce: { type: 'Permanent', subType: 'General' } });
    expect(t.rows()[0]).toMatchObject({ status: 'bounced', status_detail: 'permanent' });

    t.sqlite.run(`INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at) VALUES ('m2', 'u1', 'Next', 1, 'bot', 'complete', 1, 1)`);
    const calls = mockResend(() => Response.json({ id: 're_2' }));
    await sendRecap(t.db, t.env, 'm2');
    expect(calls).toHaveLength(0);
    expect(t.rows()[1]).toMatchObject({ status: 'failed', status_detail: 'suppressed_recipient' });
  });

  test('a temporary bounce does not stop recaps', async () => {
    const t = setup();
    await sent(t);
    await webhook(t, 'email.bounced', { email_id: 're_1', bounce: { type: 'Temporary' } });
    t.sqlite.run(`INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at) VALUES ('m2', 'u1', 'Next', 1, 'bot', 'complete', 1, 1)`);
    const calls = mockResend(() => Response.json({ id: 're_2' }));
    await sendRecap(t.db, t.env, 'm2');
    expect(calls).toHaveLength(1);
  });

  test('a spam complaint turns recaps off for the account', async () => {
    const t = setup();
    await sent(t);
    await webhook(t, 'email.delivered', { email_id: 're_1' });
    await webhook(t, 'email.complained', { email_id: 're_1' });
    expect(t.rows()[0].status).toBe('complained');
    expect((t.sqlite.query(`SELECT email_recaps FROM users WHERE id = 'u1'`).get() as { email_recaps: number }).email_recaps).toBe(0);
  });
});

describe('reconcile and account deletion', () => {
  test('re-queues a recap whose message was lost and expires one too old to matter', async () => {
    const t = setup();
    const now = Date.now();
    t.sqlite.run(`INSERT INTO meetings (id, user_id, title, started_at, source, status, created_at, updated_at) VALUES ('m_old', 'u1', 'Old', 1, 'bot', 'complete', 1, 1)`);
    t.sqlite.run(
      `INSERT INTO email_deliveries (id, user_id, meeting_id, kind, recipient, idempotency_key, provider, status, created_at, updated_at) VALUES
       ('eml_lost', 'u1', 'm1', 'meeting_recap', 'owner@example.com', 'k1', 'resend', 'queued', ?, ?),
       ('eml_old', 'u1', 'm_old', 'meeting_recap', 'owner@example.com', 'k2', 'resend', 'queued', ?, ?),
       ('eml_unknown', 'u1', 'm_old', 'meeting_recap', 'other@example.com', 'k3', 'resend', 'unknown', ?, ?)`,
      [now - RECAP_REQUEUE_AFTER_MS - 1, now - RECAP_REQUEUE_AFTER_MS - 1, now - RECAP_EXPIRE_AFTER_MS - 1, now - RECAP_EXPIRE_AFTER_MS - 1, now - RECAP_EXPIRE_AFTER_MS - 1, now - RECAP_EXPIRE_AFTER_MS - 1],
    );
    await reconcileRecaps(t.db, t.env, now);
    expect(t.sent.map((m) => m.body)).toEqual([{ kind: 'send-recap', meetingId: 'm1' }]);
    const status = (id: string) => (t.sqlite.query('SELECT status FROM email_deliveries WHERE id = ?').get(id) as { status: string }).status;
    expect(status('eml_old')).toBe('failed');
    expect(status('eml_unknown')).toBe('unknown');
  });

  test('deleting the account removes its deliveries', async () => {
    const t = setup();
    mockResend(() => Response.json({ id: 're_1' }));
    await sendRecap(t.db, t.env, 'm1');
    globalThis.fetch = realFetch;
    await handlePurgeAccount('u1', t.db, t.env);
    expect(t.rows()).toHaveLength(0);
    expect(t.sqlite.query(`SELECT id FROM users WHERE id = 'u1'`).all()).toHaveLength(0);
  });
});
