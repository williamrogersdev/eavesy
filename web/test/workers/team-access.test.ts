import { applyD1Migrations } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Route as AudioRoute } from '../../src/routes/api/audio/$';
import { Route as MediaRoute } from '../../src/routes/api/media/$';
import { Route as MeetingRoute } from '../../src/routes/api/meetings/$id';
import { Route as TeamRoute } from '../../src/routes/api/team';
import { Route as RecordingsRoute } from '../../src/routes/api/team/recordings';
import { handler, insertUser, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_ada' }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
  tryResolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
}));

// Ada owns the team, Cy is an admin, Bo is a member, Di is in no team.
const ADA = 'user_ada';
const BO = 'user_bo';
const CY = 'user_cy';
const DI = 'user_di';
const TEAM = 'team_acme';
const JOINED = 1_700_000_000_000;

/** Bo's recordings: one from before he joined, one after, one after but deleted. */
const BEFORE = 'meet_bo_before';
const AFTER = 'meet_bo_after';
const DELETED = 'meet_bo_deleted';
const ADA_OWN = 'meet_ada_own';
const audioKey = (meetingId: string, userId = BO) => `users/${userId}/meetings/${meetingId}/audio.m4a`;
const shotKey = (meetingId: string) => `users/${BO}/meetings/${meetingId}/snapshot.jpg`;

async function call(who: string, route: { options: unknown }, method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
  actor.userId = who;
  return await handler(route, method)({
    request: new Request(`https://test${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  });
}

const getMeeting = (who: string, id: string) => call(who, MeetingRoute, 'GET', `/api/meetings/${id}`, { id });
const getAudio = (who: string, key: string) => call(who, AudioRoute, 'GET', `/api/audio/${key}`, { _splat: key });
const getMedia = (who: string, key: string) => call(who, MediaRoute, 'GET', `/api/media/${key}`, { _splat: key });
const listRecordings = async (who: string) => {
  const response = await call(who, RecordingsRoute, 'GET', '/api/team/recordings');
  return { status: response.status, body: (await response.json()) as { items?: { id: string; ownerName: string | null }[] } };
};

async function addMeeting(id: string, userId: string, startedAt: number, deletedAt: number | null = null) {
  await testEnv.DB.prepare(
    `INSERT INTO meetings (id, user_id, title, description, started_at, source, language, audio_r2_key, status, created_at, updated_at, deleted_at)
     VALUES (?, ?, 'Standup', '', ?, 'desktop', 'en', ?, 'complete', ?, ?, ?)`,
  )
    .bind(id, userId, startedAt, audioKey(id, userId), startedAt, startedAt, deletedAt)
    .run();
  await testEnv.AUDIO_BUCKET.put(audioKey(id, userId), new Uint8Array([1, 2, 3]));
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('meeting_attachments', 'user_notes', 'transcript_segments', 'summaries', 'meetings', 'team_invites', 'team_members', 'teams', 'users');
  for (const id of [ADA, BO, CY, DI]) await insertUser(id);
  await testEnv.DB.prepare("UPDATE users SET display_name = 'Bo Brown' WHERE id = ?").bind(BO).run();
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES (?, 'Acme', ?, ?, ?)").bind(TEAM, ADA, JOINED - 10_000, JOINED - 10_000),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(TEAM, ADA, JOINED - 10_000),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").bind(TEAM, CY, JOINED - 5_000),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(TEAM, BO, JOINED),
  ]);
  await addMeeting(BEFORE, BO, JOINED - 60_000);
  await addMeeting(AFTER, BO, JOINED + 60_000);
  await addMeeting(DELETED, BO, JOINED + 120_000, JOINED + 130_000);
  await addMeeting(ADA_OWN, ADA, JOINED + 90_000);
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO user_notes (meeting_id, content_md, updated_at) VALUES (?, 'Bo’s private note', ?)").bind(AFTER, JOINED),
    testEnv.DB.prepare(
      `INSERT INTO meeting_attachments (id, meeting_id, user_id, kind, client_name, offset_ms, r2_key, content_type, bytes, created_at)
       VALUES ('att_after', ?, ?, 'snapshot', 'snap-1', 0, ?, 'image/jpeg', 3, ?), ('att_before', ?, ?, 'snapshot', 'snap-1', 0, ?, 'image/jpeg', 3, ?)`,
    ).bind(AFTER, BO, shotKey(AFTER), JOINED, BEFORE, BO, shotKey(BEFORE), JOINED),
  ]);
  await testEnv.AUDIO_BUCKET.put(shotKey(AFTER), new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/jpeg' } });
  await testEnv.AUDIO_BUCKET.put(shotKey(BEFORE), new Uint8Array([1, 2, 3]), { httpMetadata: { contentType: 'image/jpeg' } });
});

describe('team owners and admins reading teammates’ recordings', () => {
  it('lets the owner and an admin read a recording a member made after joining, without its private notes', async () => {
    for (const who of [ADA, CY]) {
      const response = await getMeeting(who, AFTER);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { meeting: { id: string }; notes: unknown; access: unknown };
      expect(body.meeting.id).toBe(AFTER);
      expect(body.notes).toBeNull();
      expect(body.access).toEqual({ kind: 'team', ownerName: 'Bo Brown' });
    }
  });

  it('keeps recordings from before someone joined private', async () => {
    expect((await getMeeting(ADA, BEFORE)).status).toBe(404);
    expect((await getAudio(ADA, audioKey(BEFORE))).status).toBe(403);
    expect((await getMedia(ADA, shotKey(BEFORE))).status).toBe(403);
  });

  it('shows the author their own recording with their notes', async () => {
    const response = await getMeeting(BO, AFTER);
    const body = (await response.json()) as { notes: { contentMd: string } | null; access: unknown };
    expect(body.notes?.contentMd).toBe('Bo’s private note');
    expect(body.access).toEqual({ kind: 'owner' });
  });

  it('gives members, outsiders and deleted recordings nothing', async () => {
    expect((await getMeeting(BO, ADA_OWN)).status).toBe(404);
    expect((await getAudio(BO, audioKey(ADA_OWN, ADA))).status).toBe(403);
    expect((await getMeeting(DI, AFTER)).status).toBe(404);
    expect((await getAudio(DI, audioKey(AFTER))).status).toBe(403);
    expect((await getMedia(DI, shotKey(AFTER))).status).toBe(403);
    expect((await getMeeting(ADA, DELETED)).status).toBe(404);
  });

  it('streams the audio and screenshots of a readable recording', async () => {
    expect((await getAudio(ADA, audioKey(AFTER))).status).toBe(200);
    expect((await getMedia(CY, shotKey(AFTER))).status).toBe(200);
  });

  it('never lets a reader change or delete the recording', async () => {
    const renamed = await call(ADA, MeetingRoute, 'PATCH', `/api/meetings/${AFTER}`, { id: AFTER }, { title: 'Mine now' });
    expect(renamed.status).toBe(404);
    const deleted = await call(ADA, MeetingRoute, 'DELETE', `/api/meetings/${AFTER}`, { id: AFTER });
    expect(deleted.status).toBe(404);
    expect(await row('SELECT title, deleted_at FROM meetings WHERE id = ?', AFTER)).toEqual({ title: 'Standup', deleted_at: null });
  });

  it('lists teammates’ readable recordings for owners and admins only', async () => {
    const owner = await listRecordings(ADA);
    expect(owner.status).toBe(200);
    expect(owner.body.items?.map((item) => item.id)).toEqual([AFTER]);
    expect(owner.body.items?.[0]?.ownerName).toBe('Bo Brown');

    // An admin sees every teammate, the owner included, from when each joined; never their own.
    const admin = await listRecordings(CY);
    expect(admin.body.items?.map((item) => item.id).sort()).toEqual([AFTER, ADA_OWN].sort());

    expect((await listRecordings(BO)).status).toBe(403);
    expect((await listRecordings(DI)).status).toBe(404);
  });

  it('ends the access when the member leaves the team', async () => {
    expect((await call(BO, TeamRoute, 'DELETE', '/api/team')).status).toBe(200);
    expect((await getMeeting(ADA, AFTER)).status).toBe(404);
    expect((await getAudio(ADA, audioKey(AFTER))).status).toBe(403);
    expect((await listRecordings(ADA)).body.items).toEqual([]);
  });
});
