'use client';

import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listProjects, setMeetingProject, type ProjectSummary } from '@/lib/api/projects';

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

  useEffect(() => {
    const controller = new AbortController();
    void listProjects(controller.signal).then(setProjects).catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (projects === null) return null;
  const known = projects.some((project) => project.id === projectId);

  return (
    <span className="inline-flex items-center gap-1">
      <FolderOpen className="h-3 w-3" aria-hidden />
      <select
        value={known ? projectId ?? '' : ''}
        disabled={saving}
        aria-label="Project"
        onChange={(event) => {
          const next = event.target.value;
          if (next === MANAGE) {
            window.location.assign('/app/settings#projects');
            return;
          }
          setSaving(true);
          setError(null);
          void setMeetingProject(meetingId, next || null)
            .then(onSaved)
            .catch(() => setError('Could not change the project.'))
            .finally(() => setSaving(false));
        }}
        className="max-w-[12rem] cursor-pointer truncate rounded bg-transparent text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-accent/60"
      >
        <option value="">No project</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>{project.name}</option>
        ))}
        <option value={MANAGE}>{projects.length ? 'Manage projects…' : 'Create a project…'}</option>
      </select>
      {error ? <span role="alert" className="text-danger">{error}</span> : null}
    </span>
  );
}
