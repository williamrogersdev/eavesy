import { applyD1Migrations } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as projectsRepo from '../../src/db/repo/projects';
import * as dbSchema from '../../src/db/schema';
import { combinedContext, contextTerms } from '../../src/lib/projects';
import { Route as MeetingRoute } from '../../src/routes/api/meetings/$id';
import { Route as ProjectsRoute } from '../../src/routes/api/projects/index';
import { Route as ProjectRoute } from '../../src/routes/api/projects/$id/index';
import { Route as TeamRoute } from '../../src/routes/api/team';
import { handler, insertMeeting, insertUser, resetTables, row, testEnv } from './support';

const actor = vi.hoisted(() => ({ userId: 'user_ada' }));
vi.mock('../../src/server/auth', () => ({
  resolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
  tryResolveActor: async () => ({ userId: actor.userId, isAnonymous: false }),
}));
vi.mock('../../src/server/device-auth', () => ({
  resolveIngestActor: async () => ({ userId: actor.userId, isAnonymous: false }),
}));
// Moving a recording refreshes its cleaned transcript in the background; not under test here.
vi.mock('../../src/server/agent-transcript-refresh', () => ({ refreshAgentTranscriptLater: () => undefined }));

// Ada owns the team, Cy is an admin, Bo is a member, Di is in no team.
const ADA = 'user_ada';
const BO = 'user_bo';
const CY = 'user_cy';
const DI = 'user_di';
const TEAM = 'team_acme';
const db = drizzle(testEnv.DB, { schema: dbSchema });

async function call(who: string, route: { options: unknown }, method: string, path: string, params: Record<string, string> = {}, body?: unknown) {
  actor.userId = who;
  const response = await handler(route, method)({
    request: new Request(`https://test${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    params,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function createProject(who: string, name: string, extra: Record<string, unknown> = {}) {
  const created = await call(who, ProjectsRoute, 'POST', '/api/projects', {}, { name, ...extra });
  expect(created.status).toBe(201);
  return (created.body.project as { id: string }).id;
}
const patchProject = (who: string, id: string, body: unknown) => call(who, ProjectRoute, 'PATCH', `/api/projects/${id}`, { id }, body);
const listProjects = async (who: string) =>
  (await call(who, ProjectsRoute, 'GET', '/api/projects')).body.items as { id: string; shared: boolean; canEdit: boolean; recordingCount: number }[];
const fileMeeting = (who: string, meetingId: string, folderId: string | null) =>
  call(who, MeetingRoute, 'PATCH', `/api/meetings/${meetingId}`, { id: meetingId }, { folderId });

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await resetTables('captures', 'meetings', 'folders', 'team_invites', 'team_members', 'teams', 'users');
  for (const id of [ADA, BO, CY, DI]) await insertUser(id);
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare("INSERT INTO teams (id, name, created_by, created_at, updated_at) VALUES (?, 'Acme', ?, ?, ?)").bind(TEAM, ADA, now, now),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").bind(TEAM, ADA, now),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'admin', ?)").bind(TEAM, CY, now),
    testEnv.DB.prepare("INSERT INTO team_members (team_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").bind(TEAM, BO, now),
  ]);
  await insertMeeting({ id: 'meet_bo', userId: BO, status: 'complete' });
  await insertMeeting({ id: 'meet_ada', userId: ADA, status: 'complete' });
  await insertMeeting({ id: 'meet_di', userId: DI, status: 'complete' });
});

describe('projects shared with the team', () => {
  it('shows a shared project to every member, editable only by its creator and the team’s owners and admins', async () => {
    const id = await createProject(BO, 'Billing', { about: 'The billing service.' });
    expect((await patchProject(BO, id, { shared: true })).status).toBe(200);

    expect((await listProjects(ADA)).find((p) => p.id === id)).toMatchObject({ shared: true, canEdit: true });
    expect((await listProjects(CY)).find((p) => p.id === id)).toMatchObject({ shared: true, canEdit: true });
    expect((await listProjects(BO)).find((p) => p.id === id)).toMatchObject({ shared: true, canEdit: true });
    expect((await listProjects(DI)).find((p) => p.id === id)).toBeUndefined();

    const ownersProject = await createProject(ADA, 'Roadmap');
    await patchProject(ADA, ownersProject, { shared: true });
    expect((await listProjects(BO)).find((p) => p.id === ownersProject)).toMatchObject({ shared: true, canEdit: false });
    expect((await patchProject(BO, ownersProject, { about: 'Mine now' })).status).toBe(403);
    expect((await call(BO, ProjectRoute, 'DELETE', `/api/projects/${ownersProject}`, { id: ownersProject })).status).toBe(404);
    expect(await row('SELECT about FROM folders WHERE id = ?', ownersProject)).toEqual({ about: null });
    expect((await patchProject(DI, ownersProject, { about: 'Mine now' })).status).toBe(404);
  });

  it('lets members file their own recordings into it, and outsiders not at all', async () => {
    const id = await createProject(ADA, 'Roadmap');
    expect((await fileMeeting(BO, 'meet_bo', id)).status).toBe(404);
    await patchProject(ADA, id, { shared: true });
    expect((await fileMeeting(BO, 'meet_bo', id)).status).toBe(200);
    expect((await fileMeeting(DI, 'meet_di', id)).status).toBe(404);
    // Each member counts only their own recordings in it.
    expect((await listProjects(BO)).find((p) => p.id === id)?.recordingCount).toBe(1);
    expect((await listProjects(ADA)).find((p) => p.id === id)?.recordingCount).toBe(0);
  });

  it('takes it out of teammates’ recordings when it stops being shared, and keeps the creator’s', async () => {
    const id = await createProject(ADA, 'Roadmap');
    await patchProject(ADA, id, { shared: true });
    await fileMeeting(BO, 'meet_bo', id);
    await fileMeeting(ADA, 'meet_ada', id);
    expect((await patchProject(CY, id, { shared: false })).status).toBe(200);
    expect(await row('SELECT folder_id FROM meetings WHERE id = ?', 'meet_bo')).toEqual({ folder_id: null });
    expect(await row('SELECT folder_id FROM meetings WHERE id = ?', 'meet_ada')).toEqual({ folder_id: id });
    expect((await listProjects(BO)).find((p) => p.id === id)).toBeUndefined();
  });

  it('refuses to share without a team, and hands shared projects back, out of teammates’ recordings, when the team is deleted', async () => {
    const solo = await createProject(DI, 'Side project');
    expect((await patchProject(DI, solo, { shared: true })).status).toBe(409);

    const id = await createProject(ADA, 'Roadmap');
    await patchProject(ADA, id, { shared: true });
    await fileMeeting(BO, 'meet_bo', id);
    await fileMeeting(ADA, 'meet_ada', id);
    expect((await call(ADA, TeamRoute, 'DELETE', '/api/team?everyone=1')).status).toBe(200);
    expect(await row('SELECT team_id FROM folders WHERE id = ?', id)).toEqual({ team_id: null });
    expect(await row('SELECT folder_id FROM meetings WHERE id = ?', 'meet_bo')).toEqual({ folder_id: null });
    expect(await row('SELECT folder_id FROM meetings WHERE id = ?', 'meet_ada')).toEqual({ folder_id: id });
  });

  it('stays with the team when its creator leaves, who loses it', async () => {
    const id = await createProject(BO, 'Billing', { about: 'The billing service.' });
    await patchProject(BO, id, { shared: true });
    expect((await call(BO, TeamRoute, 'DELETE', '/api/team')).status).toBe(200);

    expect((await listProjects(BO)).find((p) => p.id === id)).toBeUndefined();
    expect((await patchProject(BO, id, { about: 'Rewritten from outside' })).status).toBe(404);
    expect((await call(BO, ProjectRoute, 'DELETE', `/api/projects/${id}`, { id })).status).toBe(404);
    expect(await row('SELECT about FROM folders WHERE id = ?', id)).toEqual({ about: 'The billing service.' });
    // The team keeps it, and its admins still manage it.
    expect((await listProjects(CY)).find((p) => p.id === id)).toMatchObject({ shared: true, canEdit: true });
    expect((await patchProject(CY, id, { about: 'Owned by the team now.' })).status).toBe(200);
  });

  it('counts only your own projects toward the limit', async () => {
    const before = (await row<{ n: number }>('SELECT count(*) AS n FROM folders WHERE user_id = ?', BO))?.n;
    const id = await createProject(ADA, 'Roadmap');
    await patchProject(ADA, id, { shared: true });
    expect(await projectsRepo.countOwn(db, BO)).toBe(before);
  });
});

describe('team context', () => {
  it('is set by owners and admins, refused to members, and shown to everyone', async () => {
    expect((await call(CY, TeamRoute, 'PATCH', '/api/team', {}, { about: 'Acme makes billing software.', vocabulary: ['Acme', 'Ledgerly'] })).status).toBe(200);
    expect((await call(BO, TeamRoute, 'PATCH', '/api/team', {}, { about: 'Hijacked' })).status).toBe(403);
    const seen = await call(BO, TeamRoute, 'GET', '/api/team');
    expect(seen.body.team).toMatchObject({ about: 'Acme makes billing software.', vocabulary: ['Acme', 'Ledgerly'] });
  });

  it('reaches a member’s transcript and notes with the shared project’s context, and not an outsider’s', async () => {
    await call(ADA, TeamRoute, 'PATCH', '/api/team', {}, { about: 'Acme makes billing software.', vocabulary: ['Ledgerly'] });
    const id = await createProject(ADA, 'Roadmap', { about: 'Next quarter.', vocabulary: ['Q3 plan'] });
    await patchProject(ADA, id, { shared: true });
    await fileMeeting(BO, 'meet_bo', id);

    const { project, team } = await projectsRepo.contextForMeeting(db, { folderId: id, userId: BO });
    expect(project?.name).toBe('Roadmap');
    expect(contextTerms(project, team)).toEqual(['Q3 plan', 'Ledgerly']);
    const text = combinedContext(null, project, [], team) ?? '';
    expect(text).toContain('About the team: Acme makes billing software.');
    expect(text).toContain('Project: Roadmap');

    // Even with no project, a member gets the team's context.
    expect((await projectsRepo.contextForMeeting(db, { folderId: null, userId: BO })).team?.name).toBe('Acme');
    // An outsider pointing at the shared project gets neither.
    expect(await projectsRepo.contextForMeeting(db, { folderId: id, userId: DI })).toEqual({ project: null, team: null });
  });
});
