'use client';

import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listProjects, setMeetingProject, type ProjectSummary } from '@/lib/api/projects';
import { useRouter } from '@/lib/next-compat/navigation';

const MANAGE = '__manage__';

/** Which project a recording belongs to; changing it rebuilds the cleaned transcript. */
export function ProjectPicker({
  meetingId,
  projectId,
  onSaved,
}: {
  meetingId: string;
  projectId: string | null;
  onSaved: () => void;
}) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    void listProjects(controller.signal)
      .then(setProjects)
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadFailed(true);
      });
    return () => controller.abort();
  }, []);

  if (loadFailed) {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ev-well px-2.5 text-ev-ink-3" title="Your projects couldn't be loaded. Reload the page to try again.">
        <FolderOpen className="h-3.5 w-3.5" aria-hidden />
        Projects unavailable
      </span>
    );
  }
  if (projects === null) return null;
  const known = projects.some((project) => project.id === projectId);

  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ev-well px-2.5">
      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
      <select
        value={projectId ?? ''}
        disabled={saving}
        aria-label="Project"
        onChange={(event) => {
          const next = event.target.value;
          if (next === MANAGE) {
            event.target.value = projectId ?? '';
            void router.push('/app/projects');
            return;
          }
          setSaving(true);
          setError(null);
          void setMeetingProject(meetingId, next || null)
            .then(onSaved)
            .catch(() => setError('Could not change the project.'))
            .finally(() => setSaving(false));
        }}
        className="max-w-[12rem] cursor-pointer truncate rounded bg-transparent font-round text-[12.5px] font-semibold text-ev-ink-2 outline-none hover:text-ev-ink focus-visible:shadow-[var(--ev-focus)]"
      >
        <option value="">No project</option>
        {projectId && !known ? <option value={projectId}>Unknown project</option> : null}
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
        <option value={MANAGE}>{projects.length ? 'Manage projects…' : 'Create a project…'}</option>
      </select>
      {error ? <span role="alert" className="text-ev-warn-ink">{error}</span> : null}
    </span>
  );
}
