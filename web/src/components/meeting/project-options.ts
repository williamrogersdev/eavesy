import type { ProjectSummary } from '@/lib/api/projects';

export const MANAGE = '__manage__';

export type PickerState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; label: string }
  | { kind: 'ready'; projects: ProjectSummary[] };

/** Loads the user's projects for the picker; null means the load was cancelled. */
export async function loadPicker(
  list: (signal?: AbortSignal) => Promise<ProjectSummary[]>,
  signal?: AbortSignal,
): Promise<PickerState | null> {
  try {
    return { kind: 'ready', projects: await list(signal) };
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return null;
    return { kind: 'unavailable', label: 'Projects unavailable' };
  }
}

/** The picker's choices, keeping a project that's gone so the select still shows it. */
export function projectOptions(projects: readonly ProjectSummary[], projectId: string | null): { value: string; label: string }[] {
  const known = projects.some((project) => project.id === projectId);
  return [
    { value: '', label: 'No project' },
    ...(projectId && !known ? [{ value: projectId, label: 'Unknown project' }] : []),
    ...projects.map((project) => ({ value: project.id, label: project.name })),
    { value: MANAGE, label: projects.length ? 'Manage projects…' : 'Create a project…' },
  ];
}

/** Acts on a choice: opens project settings, or moves the recording ('' clears its project). */
export async function chooseProject(
  meetingId: string,
  value: string,
  actions: { manage: () => void; assign: (meetingId: string, projectId: string | null) => Promise<void> },
): Promise<'managed' | 'assigned'> {
  if (value === MANAGE) {
    actions.manage();
    return 'managed';
  }
  await actions.assign(meetingId, value || null);
  return 'assigned';
}
