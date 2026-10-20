'use client';

import { FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { listProjects, setMeetingProject } from '@/lib/api/projects';
import { useRouter } from '@/lib/next-compat/navigation';
import { chooseProject, loadPicker, projectOptions, type PickerState } from './project-options';

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
  const [state, setState] = useState<PickerState>({ kind: 'loading' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    const controller = new AbortController();
    void loadPicker(listProjects, controller.signal).then((next) => {
      if (next) setState(next);
    });
    return () => controller.abort();
  }, []);

  if (state.kind === 'unavailable') {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ev-well px-2.5 text-ev-ink-3" title="Your projects couldn't be loaded. Reload the page to try again.">
        <FolderOpen className="h-3.5 w-3.5" aria-hidden />
        {state.label}
      </span>
    );
  }
  if (state.kind === 'loading') return null;

  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ev-well px-2.5">
      <FolderOpen className="h-3.5 w-3.5" aria-hidden />
      <select
        value={projectId ?? ''}
        disabled={saving}
        aria-label="Project"
        onChange={(event) => {
          const select = event.target;
          setError(null);
          void chooseProject(meetingId, select.value, {
            manage: () => {
              select.value = projectId ?? '';
              void router.push('/app/settings#projects');
            },
            assign: async (id, next) => {
              setSaving(true);
              try {
                await setMeetingProject(id, next);
              } finally {
                setSaving(false);
              }
            },
          })
            .then((done) => {
              if (done === 'assigned') onSaved();
            })
            .catch(() => setError('Could not change the project.'));
        }}
        className="max-w-[12rem] cursor-pointer truncate rounded bg-transparent font-round text-[12.5px] font-semibold text-ev-ink-2 outline-none hover:text-ev-ink focus-visible:shadow-[var(--ev-focus)]"
      >
        {projectOptions(state.projects, projectId).map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {error ? <span role="alert" className="text-ev-warn-ink">{error}</span> : null}
    </span>
  );
}
