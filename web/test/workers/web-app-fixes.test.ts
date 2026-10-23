/// <reference types="vite/client" />
import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handler, insertDeviceActor, insertMeeting, insertUser, requestBody, resetTables, row, testEnv } from './support';
import { Route as RegenerateRoute } from '../../src/routes/api/meetings/$id/regenerate';
import { Route as SearchRoute } from '../../src/routes/api/search';
import { Route as CapturesRoute } from '../../src/routes/api/captures';
import { Route as CaptureRoute } from '../../src/routes/api/captures/$id';
import { Route as CaptureAudioRoute } from '../../src/routes/api/captures/$id/audio';
import { Route as DeviceCapturesRoute } from '../../src/routes/api/devices/captures/index';
import { Route as TemplatesRoute } from '../../src/routes/api/templates';
import { Route as McpTokensRoute } from '../../src/routes/api/mcp-tokens';
import { TEMPLATE_LIMIT } from '../../src/db/repo/templates';

const actor = vi.hoisted(() => ({ userId: null as string | null }));
const summarizer = vi.hoisted(() => ({ inputs: [] as { transcript: string; speakers?: string; contextBlurb?: string }[] }));
const queued = vi.hoisted(() => ({ messages: [] as { kind: string; meetingId?: string }[] }));
vi.mock('../../src/server/queue', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  enqueue: async (message: { kind: string; meetingId?: string }) => {
    queued.messages.push(message);
  },
}));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => {
    if (!actor.userId) throw new Error('not_authenticated');
    return { userId: actor.userId, isAnonymous: false };
  },
  tryResolveActor: async () => (actor.userId ? { userId: actor.userId, isAnonymous: false } : null),
}));
vi.mock('../../src/lib/ai/summarize', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  summarizeMeeting: async (input: { transcript: string; speakers?: string; contextBlurb?: string }) => {
    summarizer.inputs.push(input);
    return {
    title: 'Regenerated',
    description: '',
    tldr: 'Regenerated brief',
    decisions: [],
    actionItems: [],
    followUps: [],
    openQuestions: [],
    topics: [],
    mentions: [],
    };
  },
}));
vi.mock('../../src/lib/vision', () => ({
  isSupportedImageType: () => true,
  extractVisualText: async () => ({ empty: false, text: 'Text on screen' }),
}));
vi.mock('../../src/lib/transcription/transcribe-file', () => ({
  transcribeAudioFile: async () => ({ text: 'Words from the video' }),
}));

const USER = 'user_fixes';
const OTHER = 'user_fixes_other';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

const call = (route: { options: unknown }, method: string, url: string, init: RequestInit = {}, params: Record<string, string> = {}) =>
  handler(route, method)({ request: new Request(`https://eavesy.test${url}`, { method, ...init }), params });

const jsonInit = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await testEnv.DB.prepare('DELETE FROM rate_limits').run().catch(() => undefined);
  await resetTables(
    'transcript_segments',
    'summaries',
    'user_notes',
    'captures',
    'prompt_templates',
    'mcp_tokens',
    'activity_log',
    'meetings',
    'device_tokens',
    'devices',
    'users',
  );
  await insertUser(USER);
  await insertUser(OTHER);
  actor.userId = USER;
  summarizer.inputs.length = 0;
  queued.messages.length = 0;
});

async function addSegment(meetingId: string, text: string) {
  await testEnv.DB.prepare(
    `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text, is_final, is_edited)
     VALUES (?, ?, 0, 1000, ?, 1, 0)`,
  ).bind(`line_${meetingId}`, meetingId, text).run();
}

describe('regenerate', () => {
  it.each(['recording', 'uploading', 'processing'])('refuses a %s meeting and leaves its status alone', async (status) => {
    await insertMeeting({ id: 'meet_live', userId: USER, status });
    await addSegment('meet_live', 'Partial words');
    const response = await call(RegenerateRoute, 'POST', '/api/meetings/meet_live/regenerate', jsonInit({}), { id: 'meet_live' });
    expect(response.status).toBe(409);
    expect(await row('SELECT status FROM meetings WHERE id = ?', 'meet_live')).toEqual({ status });
    expect(await row('SELECT id FROM summaries WHERE meeting_id = ?', 'meet_live')).toBeNull();
    // Refused before the quota is spent.
    expect(await row("SELECT count(*) AS n FROM rate_limits WHERE key LIKE '%regenerate%'")).toMatchObject({ n: 0 });
  });

  it('rewrites a complete meeting and brings a failed one back to complete, then queues what follows a brief', async () => {
    await insertMeeting({ id: 'meet_done', userId: USER, status: 'complete' });
    await insertMeeting({ id: 'meet_failed', userId: USER, status: 'failed' });
    await addSegment('meet_done', 'Final words');
    await addSegment('meet_failed', 'Final words');
    for (const id of ['meet_done', 'meet_failed']) {
      const response = await call(RegenerateRoute, 'POST', `/api/meetings/${id}/regenerate`, jsonInit({}), { id });
      expect(response.status).toBe(200);
      expect(await row('SELECT status, title FROM meetings WHERE id = ?', id)).toEqual({ status: 'complete', title: 'Regenerated' });
      // A failed meeting never had an embedding; a rewritten brief changes the
      // one a complete meeting has. Both get re-indexed and their agent
      // transcript rebuilt, as after the pipeline's own brief.
      expect(queued.messages.filter((m) => m.meetingId === id).map((m) => m.kind)).toEqual(['embed', 'agent-transcript']);
      expect(await row('SELECT generated_by_model, template_id FROM summaries WHERE meeting_id = ?', id)).toEqual({
        generated_by_model: 'claude-sonnet-4-6',
        template_id: 'standard',
      });
    }
    // One row per meeting however many times it is regenerated.
    expect(await row("SELECT count(*) AS n FROM summaries WHERE meeting_id = 'meet_done'")).toEqual({ n: 1 });
    await call(RegenerateRoute, 'POST', '/api/meetings/meet_done/regenerate', jsonInit({ format: 'standard' }), { id: 'meet_done' });
    expect(await row("SELECT count(*) AS n FROM summaries WHERE meeting_id = 'meet_done'")).toEqual({ n: 1 });
  });

  it('summarizes the transcript the pipeline would, with its speakers named', async () => {
    await insertMeeting({ id: 'meet_two', userId: USER, status: 'complete' });
    await testEnv.DB.prepare("UPDATE meetings SET speaker_names_json = ? WHERE id = 'meet_two'").bind(JSON.stringify({ you: 'Ada', them: 'Grace' })).run();
    await testEnv.DB.prepare(
      `INSERT INTO transcript_segments (id, meeting_id, start_ms, end_ms, text, speaker_id, is_final, is_edited)
       VALUES ('l1', 'meet_two', 0, 1000, 'Shall we ship it', 'you', 1, 0), ('l2', 'meet_two', 1000, 2000, 'Yes, on Friday', 'them', 1, 0)`,
    ).run();
    const response = await call(RegenerateRoute, 'POST', '/api/meetings/meet_two/regenerate', jsonInit({}), { id: 'meet_two' });
    expect(response.status).toBe(200);
    const input = summarizer.inputs.at(-1)!;
    expect(input.transcript).toBe('Ada: Shall we ship it\nGrace: Yes, on Friday');
    expect(input.speakers).toContain('"Ada" is the person who recorded the meeting');

    // A transcript the user rewrote by hand is sent as is, with no speaker claim.
    await testEnv.DB.prepare("UPDATE meetings SET transcript_override_md = 'My own words' WHERE id = 'meet_two'").run();
    await call(RegenerateRoute, 'POST', '/api/meetings/meet_two/regenerate', jsonInit({}), { id: 'meet_two' });
    expect(summarizer.inputs.at(-1)).toMatchObject({ transcript: 'My own words', speakers: undefined });
  });
});

describe('search', () => {
  it('matches % and _ literally and survives a bad limit', async () => {
    await insertMeeting({ id: 'meet_pct', userId: USER, status: 'complete' });
    await insertMeeting({ id: 'meet_plain', userId: USER, status: 'complete' });
    await testEnv.DB.prepare("UPDATE meetings SET title = 'Budget 100% approved' WHERE id = 'meet_pct'").run();
    await testEnv.DB.prepare("UPDATE meetings SET title = 'Budget review' WHERE id = 'meet_plain'").run();

    const pct = await call(SearchRoute, 'GET', `/api/search?q=${encodeURIComponent('100%')}`);
    expect(pct.status).toBe(200);
    const pctItems = ((await pct.json()) as { items: { meeting: { id: string } }[] }).items.map((i) => i.meeting.id);
    expect(pctItems).toEqual(['meet_pct']);

    const underscore = await call(SearchRoute, 'GET', `/api/search?q=${encodeURIComponent('Budget_')}`);
    expect(((await underscore.json()) as { items: unknown[] }).items).toEqual([]);

    for (const limit of ['-1', '0', 'abc']) {
      const response = await call(SearchRoute, 'GET', `/api/search?q=Budget&limit=${limit}`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(2);
    }
  });
});

describe('captures', () => {
  async function insertCapture(id: string, createdAt: number) {
    await testEnv.DB.prepare(
      `INSERT INTO captures (id, user_id, kind, capture_mode, title, r2_key, content_type, bytes, created_at, updated_at)
       VALUES (?, ?, 'image', 'screenshot', ?, ?, 'image/png', 3, ?, ?)`,
    ).bind(id, USER, id, `users/${USER}/captures/${id}.png`, createdAt, createdAt).run();
  }

  it('clamps the limit and pages back with before', async () => {
    await insertCapture('cap_1', 1000);
    await insertCapture('cap_2', 2000);
    await insertCapture('cap_3', 3000);
    const all = (await (await call(CapturesRoute, 'GET', '/api/captures?limit=-1')).json()) as { items: { id: string }[] };
    expect(all.items.map((c) => c.id)).toEqual(['cap_3', 'cap_2', 'cap_1']);

    const first = (await (await call(CapturesRoute, 'GET', '/api/captures?limit=2')).json()) as { items: { id: string }[]; nextBefore: number };
    expect(first.items.map((c) => c.id)).toEqual(['cap_3', 'cap_2']);
    const older = (await (await call(CapturesRoute, 'GET', `/api/captures?limit=2&before=${first.nextBefore}`)).json()) as { items: { id: string }[] };
    expect(older.items.map((c) => c.id)).toEqual(['cap_1']);
  });

  it('stores a raw-body screenshot under its own id and returns only public fields', async () => {
    const response = await call(CapturesRoute, 'POST', '/api/captures', {
      headers: {
        'content-type': 'image/png',
        'content-length': String(PNG.byteLength),
        'x-capture-mode': 'screenshot',
        'x-title': encodeURIComponent('Screenshot — 22 Oct 2026, 09:15'),
      },
      body: requestBody(PNG),
    });
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    expect(await row('SELECT r2_key, title, transcript, transcript_status FROM captures WHERE id = ?', id)).toEqual({
      r2_key: `users/${USER}/captures/${id}.png`,
      title: 'Screenshot — 22 Oct 2026, 09:15',
      transcript: 'Text on screen',
      transcript_status: 'complete',
    });
    const stored = await testEnv.AUDIO_BUCKET.get(`users/${USER}/captures/${id}.png`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(PNG);

    const detail = (await (await call(CaptureRoute, 'GET', `/api/captures/${id}`, {}, { id })).json()) as Record<string, unknown>;
    expect(detail.id).toBe(id);
    expect(detail.url).toContain(id);
    for (const hidden of ['r2Key', 'deviceId', 'clientCaptureId', 'userId']) expect(detail).not.toHaveProperty(hidden);
  });

  it('refuses a bad mode or oversize upload before spending quota', async () => {
    const badMode = await call(CapturesRoute, 'POST', '/api/captures', {
      headers: { 'content-type': 'image/png', 'content-length': '8', 'x-capture-mode': 'audio' },
      body: requestBody(PNG),
    });
    expect(badMode.status).toBe(400);
    const tooBig = await call(CapturesRoute, 'POST', '/api/captures', {
      headers: { 'content-type': 'video/webm', 'content-length': String(200 * 1024 * 1024), 'x-capture-mode': 'screen' },
      body: requestBody(PNG),
    });
    expect(tooBig.status).toBe(413);
    expect(await row("SELECT count(*) AS n FROM rate_limits WHERE key LIKE '%capture%'")).toMatchObject({ n: 0 });
  });

  it('transcribes a video capture’s audio once, for its owner only', async () => {
    const video = await call(CapturesRoute, 'POST', '/api/captures', {
      headers: { 'content-type': 'video/webm', 'content-length': String(PNG.byteLength), 'x-capture-mode': 'screen', 'x-duration-ms': '4000' },
      body: requestBody(PNG),
    });
    expect(video.status).toBe(200);
    const { id } = (await video.json()) as { id: string };
    expect(await row('SELECT kind, duration_sec, transcript_status FROM captures WHERE id = ?', id)).toEqual({
      kind: 'video',
      duration_sec: 4,
      transcript_status: 'none',
    });

    const audio = () => ({ headers: { 'content-type': 'audio/webm' }, body: requestBody(PNG) });
    actor.userId = OTHER;
    expect((await call(CaptureAudioRoute, 'POST', `/api/captures/${id}/audio`, audio(), { id })).status).toBe(404);
    actor.userId = USER;
    expect((await call(CaptureAudioRoute, 'POST', `/api/captures/${id}/audio`, audio(), { id })).status).toBe(200);
    expect(await row('SELECT transcript, transcript_status FROM captures WHERE id = ?', id)).toEqual({
      transcript: 'Words from the video',
      transcript_status: 'complete',
    });
    expect((await call(CaptureAudioRoute, 'POST', `/api/captures/${id}/audio`, audio(), { id })).status).toBe(409);
  });

  it('names a synced Mac image’s R2 object after the capture id', async () => {
    const token = await insertDeviceActor('user_mac', 'device_mac');
    const response = await call(DeviceCapturesRoute, 'POST', '/api/devices/captures', {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'image/png',
        'content-length': String(PNG.byteLength),
        'x-client-capture-id': crypto.randomUUID(),
      },
      body: requestBody(PNG),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    expect(await row('SELECT r2_key FROM captures WHERE id = ?', id)).toEqual({ r2_key: `users/user_mac/captures/${id}.png` });
  });
});

describe('templates', () => {
  it(`keeps at most ${TEMPLATE_LIMIT} per account`, async () => {
    const statements = Array.from({ length: TEMPLATE_LIMIT }, (_, i) =>
      testEnv.DB.prepare(
        `INSERT INTO prompt_templates (id, user_id, name, system_prompt, applies_to, sort_order) VALUES (?, ?, ?, 'Prompt', 'meeting', 0)`,
      ).bind(`tpl_${i}`, USER, `Template ${i}`),
    );
    await testEnv.DB.batch(statements);
    const body = { name: 'One more', systemPrompt: 'Prompt', appliesTo: 'meeting' };
    expect((await call(TemplatesRoute, 'POST', '/api/templates', jsonInit(body))).status).toBe(409);

    actor.userId = OTHER;
    const created = await call(TemplatesRoute, 'POST', '/api/templates', jsonInit(body));
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: string };
    expect(await row('SELECT user_id, name, is_default, sort_order FROM prompt_templates WHERE id = ?', id)).toEqual({
      user_id: OTHER,
      name: 'One more',
      is_default: 0,
      sort_order: 0,
    });
  });
});

describe('mcp tokens', () => {
  it('tells a bad request apart from a signed-out one', async () => {
    expect((await call(McpTokensRoute, 'POST', '/api/mcp-tokens', jsonInit({ name: '' }))).status).toBe(400);
    expect((await call(McpTokensRoute, 'DELETE', '/api/mcp-tokens', jsonInit({}))).status).toBe(400);
    actor.userId = null;
    expect((await call(McpTokensRoute, 'POST', '/api/mcp-tokens', jsonInit({ name: 'x' }))).status).toBe(401);
  });
});
