'use client';

import { Check, FolderOpen, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { AppSection, appButton } from '@/components/ui/app-page';
import {
  createProject,
  deleteProject,
  listProjects,
  projectSuggestions,
  updateProject,
  type ProjectSummary,
} from '@/lib/api/projects';
import { PROJECT_LIMITS } from '@/lib/projects';
import { cn } from '@/lib/utils';
import { CLOSED, formReducer, saveProject, type Draft } from './project-form';
import { TermInput } from './term-input';

export function ProjectManager() {
  const [items, setItems] = useState<ProjectSummary[]>([]);
  const [form, dispatch] = useReducer(formReducer, CLOSED);
  const { open: formOpen, editingId, deletingId, draft } = form;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setItems(await listProjects(signal));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((cause: unknown) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setMessage('Could not load your projects.');
    });
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!editingId) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    void projectSuggestions(editingId, controller.signal).then(setSuggestions).catch(() => setSuggestions([]));
    return () => controller.abort();
  }, [editingId]);

  const close = () => dispatch({ type: 'close' });
  const patch = (fields: Partial<Draft>) => dispatch({ type: 'draft', patch: fields });

  const edit = (project: ProjectSummary) => {
    dispatch({ type: 'edit', project });
    setMessage(null);
  };

  const save = async () => {
    if (!draft.name.trim()) return;
    setBusy(true);
    setMessage(null);
    const result = await saveProject({
      editingId,
      draft,
      create: createProject,
      update: updateProject,
      reload: () => load(),
      onSaved: close,
    });
    setMessage(result.message);
    setBusy(false);
  };

  const remove = async (project: ProjectSummary) => {
    if (deletingId !== project.id) {
      dispatch({ type: 'askDelete', id: project.id });
      setMessage(`Click again to delete ${project.name}. Its recordings stay in your library.`);
      return;
    }
    setBusy(true);
    try {
      await deleteProject(project.id);
      setItems((current) => current.filter((item) => item.id !== project.id));
      dispatch({ type: 'deleted', id: project.id });
      setMessage('Project deleted.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not delete the project.');
    } finally {
      setBusy(false);
    }
  };

  const field = 'w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm outline-none focus:border-ev-coat';
  const label = 'text-xs font-medium text-ev-ink-2';
  return (
    <AppSection
      id="projects"
      title="Projects"
      description="What you're working on. A recording's project helps Eavesy spell your terms and names, and the Mac app picks it from the window you're in."
      action={formOpen ? null : (
        <button
          type="button"
          onClick={() => { dispatch({ type: 'new' }); setMessage(null); }}
          className={appButton('secondary', 'sm')}
        >
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      )}
    >
      {items.length ? (
        <ul className="divide-y divide-ev-line rounded-[var(--ev-r-ctl)] border border-ev-line">
          {items.map((project) => (
            <li key={project.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <FolderOpen className="h-4 w-4 shrink-0 text-ev-ink-2" />
                <div className="min-w-0">
                  <p className="truncate text-sm">{project.name}</p>
                  <p className="truncate text-xs text-ev-ink-2">
                    {project.about || `${project.vocabulary.length} term${project.vocabulary.length === 1 ? '' : 's'}`}
                    {` · ${project.recordingCount} recording${project.recordingCount === 1 ? '' : 's'}`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 gap-0.5">
                <button type="button" onClick={() => edit(project)} aria-label={`Edit ${project.name}`} className={appButton('ghost', 'sm')}>
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(project)}
                  disabled={busy}
                  aria-label={deletingId === project.id ? `Confirm deleting ${project.name}` : `Delete ${project.name}`}
                  className={cn(appButton('ghost', 'sm'), 'text-ev-warn-ink hover:text-ev-warn-ink')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {deletingId === project.id ? 'Confirm' : null}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : formOpen ? null : (
        <p className="text-xs text-ev-ink-2">No projects yet. Create one for each codebase or client you record about.</p>
      )}

      {formOpen ? (
        <div className="flex flex-col gap-3 rounded-[var(--ev-r-ctl)] border border-ev-line p-3">
          <div className="flex items-center justify-between">
            <p className={label}>{editingId ? 'Edit project' : 'New project'}</p>
            <button type="button" onClick={close} aria-label="Close project editor" className={appButton('ghost', 'sm')}>
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            <span className={label}>Name</span>
            <input
              value={draft.name}
              onChange={(event) => patch({ name: event.target.value })}
              maxLength={PROJECT_LIMITS.name}
              placeholder="eavesy"
              autoFocus
              className={cn(field, 'h-9')}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>About</span>
            <textarea
              value={draft.about}
              onChange={(event) => patch({ about: event.target.value })}
              maxLength={PROJECT_LIMITS.about}
              rows={2}
              placeholder="Mac meeting recorder. TanStack Start on Cloudflare Workers, Tauri and Swift desktop app."
              className={cn(field, 'py-2 leading-relaxed')}
            />
            <span className="text-[11px] text-ev-ink-2">One or two lines. Summaries treat it as background.</span>
          </label>
          <div className="flex flex-col gap-1">
            <span className={label}>Vocabulary</span>
            <TermInput
              label="Vocabulary"
              value={draft.vocabulary}
              onChange={(vocabulary) => patch({ vocabulary })}
              placeholder="Tauri, D1, wrangler…"
              max={PROJECT_LIMITS.vocabulary}
              suggestions={suggestions}
            />
            <span className="text-[11px] text-ev-ink-2">
              Names, libraries and identifiers you say often. Transcription spells these right; the first few dozen count most.
            </span>
          </div>
          <label className="flex flex-col gap-1">
            <span className={label}>People</span>
            <input
              value={draft.people}
              onChange={(event) => patch({ people: event.target.value })}
              maxLength={PROJECT_LIMITS.people}
              placeholder="Maya (design), Alex (backend)"
              className={cn(field, 'h-9')}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className={label}>Detect when the window title has</span>
            <TermInput
              label="Detect when the window title has"
              value={draft.match}
              onChange={(match) => patch({ match })}
              placeholder={draft.name.trim() || 'repo or folder name'}
              max={PROJECT_LIMITS.match}
            />
            <span className="text-[11px] text-ev-ink-2">
              The Mac app picks this project when the app you&apos;re in shows one of these words, like a repo name in
              Cursor or Terminal. Empty means the project name.
            </span>
          </div>
          <div className="flex justify-end">
            <button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim()} className={appButton('primary', 'sm')}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {editingId ? 'Save' : 'Create'}
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p aria-live="polite" className="text-xs text-ev-ink-2">{message}</p> : null}
    </AppSection>
  );
}
