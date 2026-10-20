'use client';

import { FolderOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AppAlert, AppEmptyState, AppPageHeader, appButton } from '@/components/ui/app-page';
import { SaveToast, useSaveToast } from '@/components/ui/save-toast';
import { createProject, deleteProject, listProjects, updateProject, type ProjectSummary } from '@/lib/api/projects';
import { projectWords } from '@/lib/projects';
import { cn } from '@/lib/utils';
import { ProjectEditor, type ProjectSave } from './project-editor';

let cache: ProjectSummary[] | null = null;

const PENDING = 'pending-';

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function ProjectManager() {
  const [items, setItemsState] = useState<ProjectSummary[] | null>(cache);
  const [editing, setEditing] = useState<string | null>(null);
  const [retry, setRetry] = useState<ProjectSummary | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const toast = useSaveToast();
  const local = useRef({ added: new Set<string>(), edited: new Set<string>(), deleted: new Set<string>() });
  const saves = useRef(new Map<string, { attempt: number; confirmedAttempt: number; confirmed: ProjectSummary }>());

  const setItems = (update: (current: ProjectSummary[]) => ProjectSummary[]) => {
    setItemsState((current) => {
      const next = update(current ?? []);
      cache = next;
      return next;
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    void listProjects(controller.signal)
      .then((fresh) => {
        setItemsState((current) => {
          const { added, edited, deleted } = local.current;
          const mine = new Map((current ?? []).map((item) => [item.id, item]));
          const merged = fresh
            .filter((item) => !deleted.has(item.id))
            .map((item) => (edited.has(item.id) ? mine.get(item.id) ?? item : item));
          const known = new Set(merged.map((item) => item.id));
          for (const item of current ?? []) {
            if (!known.has(item.id) && !deleted.has(item.id) && (item.id.startsWith(PENDING) || added.has(item.id))) merged.push(item);
          }
          cache = merged;
          return merged;
        });
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        setLoadFailed(true);
        setItemsState((current) => current ?? []);
        setError('Could not load your projects. Reload the page to try again.');
      });
    return () => controller.abort();
  }, []);

  const startNew = () => {
    setError(null);
    setRetry(null);
    setConfirming(null);
    setEditing('new');
  };

  const close = () => {
    setEditing(null);
    setRetry(null);
  };

  const create = (fields: ProjectSave) => {
    const pendingId = `${PENDING}${Date.now()}`;
    const pending: ProjectSummary = { id: pendingId, recordingCount: 0, ...fields };
    setItems((current) => [...current, pending]);
    close();
    setError(null);
    toast.show('Project created');
    void createProject(fields)
      .then((saved) => {
        local.current.added.add(saved.id);
        setItems((current) => current.map((item) => (item.id === pendingId ? saved : item)));
      })
      .catch((cause: unknown) => {
        setItems((current) => current.filter((item) => item.id !== pendingId));
        setError(cause instanceof Error ? `Could not create the project: ${cause.message}` : 'Could not create the project.');
        setRetry(pending);
        setEditing('new');
      });
  };

  const save = (project: ProjectSummary, fields: ProjectSave) => {
    const updated = { ...project, ...fields };
    const previous = saves.current.get(project.id);
    const attempt = (previous?.attempt ?? 0) + 1;
    saves.current.set(project.id, { attempt, confirmedAttempt: previous?.confirmedAttempt ?? 0, confirmed: previous?.confirmed ?? project });
    local.current.edited.add(project.id);
    setItems((current) => current.map((item) => (item.id === project.id ? updated : item)));
    close();
    setError(null);
    toast.show();
    void updateProject(project.id, fields)
      .then(() => {
        const entry = saves.current.get(project.id);
        if (entry && attempt > entry.confirmedAttempt) saves.current.set(project.id, { ...entry, confirmedAttempt: attempt, confirmed: updated });
      })
      .catch((cause: unknown) => {
        const entry = saves.current.get(project.id);
        if (!entry || entry.attempt !== attempt) return;
        setItems((current) => current.map((item) => (item.id === project.id ? entry.confirmed : item)));
        setError(cause instanceof Error ? `Could not save ${project.name}: ${cause.message}` : `Could not save ${project.name}.`);
      });
  };

  const remove = (project: ProjectSummary) => {
    if (confirming !== project.id) {
      setConfirming(project.id);
      return;
    }
    setConfirming(null);
    local.current.deleted.add(project.id);
    let index = -1;
    setItems((current) => {
      index = current.findIndex((item) => item.id === project.id);
      return current.filter((item) => item.id !== project.id);
    });
    if (editing === project.id) close();
    toast.show('Project deleted');
    void deleteProject(project.id).catch((cause: unknown) => {
      local.current.deleted.delete(project.id);
      setItems((current) => {
        const next = [...current];
        if (next.some((item) => item.id === project.id)) return next;
        next.splice(index < 0 ? next.length : Math.min(index, next.length), 0, project);
        return next;
      });
      setError(cause instanceof Error ? `Could not delete ${project.name}: ${cause.message}` : `Could not delete ${project.name}.`);
    });
  };

  return (
    <>
      <AppPageHeader
        title="Projects"
        description="One for each client, codebase or team you record about. A recording's project tells Eavesy which words to spell right, and the Mac app picks it from the window you're in."
        action={items && items.length > 0 && editing !== 'new' ? (
          <button type="button" onClick={startNew} className={appButton('primary')}>
            <Plus className="h-4 w-4" /> New project
          </button>
        ) : null}
      />

      {error ? <AppAlert>{error}</AppAlert> : null}

      {editing === 'new' ? (
        <ProjectEditor key={retry?.id ?? 'new'} project={retry} creating onSave={create} onCancel={close} />
      ) : null}

      {items === null ? (
        <ul aria-busy="true" aria-label="Loading projects" className="flex flex-col gap-2">
          {[0, 1, 2].map((row) => (
            <li key={row} className="h-[68px] animate-pulse rounded-[var(--ev-r-panel)] bg-ev-well" />
          ))}
        </ul>
      ) : items.length === 0 && loadFailed ? null : items.length === 0 && editing !== 'new' ? (
        <AppEmptyState
          icon={<FolderOpen />}
          title="No projects yet"
          description="Add the names and terms you say often, and Eavesy spells them right in every recording for that project."
          action={(
            <button type="button" onClick={startNew} className={appButton('primary')}>
              <Plus className="h-4 w-4" /> Create a project
            </button>
          )}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((project) =>
            editing === project.id ? (
              <li key={project.id}>
                <ProjectEditor project={project} onSave={(fields) => save(project, fields)} onCancel={close} />
              </li>
            ) : (
              <ProjectRow
                key={project.id}
                project={project}
                confirming={confirming === project.id}
                onEdit={() => {
                  setError(null);
                  setConfirming(null);
                  setRetry(null);
                  setEditing(project.id);
                }}
                onDelete={() => remove(project)}
                onCancelDelete={() => setConfirming(null)}
              />
            ),
          )}
        </ul>
      )}

      <SaveToast text={toast.text} />
    </>
  );
}

function ProjectRow({
  project,
  confirming,
  onEdit,
  onDelete,
  onCancelDelete,
}: {
  project: ProjectSummary;
  confirming: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCancelDelete: () => void;
}) {
  const pending = project.id.startsWith(PENDING);
  const words = projectWords(project);
  const shown = words.slice(0, 8);
  return (
    <li
      className={cn(
        'group flex items-start gap-3 rounded-[var(--ev-r-panel)] bg-ev-raised p-3.5 shadow-[0_0_0_0.5px_var(--ev-line-strong)] transition',
        pending && 'opacity-70',
      )}
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ev-manila-soft text-ev-manila-ink">
        <FolderOpen className="h-4 w-4" strokeWidth={1.75} />
      </span>
      <button
        type="button"
        onClick={onEdit}
        disabled={pending}
        className="min-w-0 flex-1 text-left"
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="max-w-full truncate font-round text-[15px] font-bold text-ev-ink">{project.name}</span>
          <span className="shrink-0 text-xs text-ev-ink-2">
            {plural(project.recordingCount, 'recording')} · {plural(words.length, 'word')}
          </span>
        </span>
        {project.about ? <span className="mt-0.5 block truncate text-[13px] text-ev-ink-2">{project.about}</span> : null}
        {shown.length > 0 ? (
          <span className="mt-2 flex flex-wrap gap-1">
            {shown.map((word) => (
              <span key={word} className="rounded-full bg-ev-well px-2 py-0.5 text-[12px] text-ev-ink-2">{word}</span>
            ))}
            {words.length > shown.length ? (
              <span className="px-1 py-0.5 text-[12px] text-ev-ink-3">+{words.length - shown.length} more</span>
            ) : null}
          </span>
        ) : null}
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        {confirming ? (
          <>
            <button type="button" onClick={onCancelDelete} className={appButton('ghost', 'sm')}>
              Keep
            </button>
            <button type="button" onClick={onDelete} className={appButton('danger', 'sm')}>
              Delete
            </button>
          </>
        ) : (
          <>
            <button type="button" onClick={onEdit} disabled={pending} aria-label={`Edit ${project.name}`} className={appButton('ghost', 'sm')}>
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onDelete}
              disabled={pending}
              aria-label={`Delete ${project.name}`}
              title="Recordings stay in your library"
              className={cn(appButton('ghost', 'sm'), 'hover:text-ev-warn-ink')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
