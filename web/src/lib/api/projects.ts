import { isRecord } from '@/lib/json';
import type { Project } from '@/lib/projects';

export interface ProjectSummary extends Project {
  recordingCount: number;
}

export type ProjectFields = Partial<Omit<Project, 'id'>>;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function parseProject(value: unknown): ProjectSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
  return {
    id: value.id,
    name: value.name,
    about: typeof value.about === 'string' ? value.about : null,
    vocabulary: strings(value.vocabulary),
    people: typeof value.people === 'string' ? value.people : null,
    match: strings(value.match),
    recordingCount: typeof value.recordingCount === 'number' ? value.recordingCount : 0,
  };
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = isRecord(body) && typeof body.error === 'string' ? body.error : `status ${response.status}`;
    throw new Error(code === 'too_many_projects' ? 'You have reached the project limit.' : `Server returned ${code}`);
  }
  return await response.json();
}

export async function listProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
  const body = await json(await fetch('/api/projects', { signal }));
  if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('Invalid projects response');
  return body.items.flatMap((item) => parseProject(item) ?? []);
}

export async function createProject(fields: ProjectFields & { name: string }): Promise<ProjectSummary> {
  const body = await json(
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  );
  const project = isRecord(body) ? parseProject(body.project) : null;
  if (!project) throw new Error('Invalid project response');
  return project;
}

export async function updateProject(id: string, fields: ProjectFields): Promise<void> {
  await json(
    await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  );
}

export async function deleteProject(id: string): Promise<void> {
  await json(await fetch(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function projectSuggestions(id: string, signal?: AbortSignal): Promise<string[]> {
  const body = await json(await fetch(`/api/projects/${encodeURIComponent(id)}/suggestions`, { signal }));
  return isRecord(body) ? strings(body.terms) : [];
}

export async function setMeetingProject(meetingId: string, projectId: string | null): Promise<void> {
  await json(
    await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderId: projectId }),
    }),
  );
}
