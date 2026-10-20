'use client';

import { useEffect, useId, useState } from 'react';
import { ChipInput } from '@/components/ui/chip-input';
import { appButton } from '@/components/ui/app-page';
import { projectSuggestions, type ProjectFields, type ProjectSummary } from '@/lib/api/projects';
import { cleanList, PROJECT_LIMITS, projectWords, wordsToFields } from '@/lib/projects';

export type ProjectSave = Required<Pick<ProjectFields, 'about' | 'vocabulary' | 'people' | 'match'>> & { name: string };

export function ProjectEditor({
  project,
  creating = false,
  onSave,
  onCancel,
}: {
  project: ProjectSummary | null;
  creating?: boolean;
  onSave: (fields: ProjectSave) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState(project?.name ?? '');
  const [about, setAbout] = useState(project?.about ?? '');
  const [words, setWords] = useState<string[]>(() => (project ? projectWords(project) : []));
  const [match, setMatch] = useState<string[]>(project?.match ?? []);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const projectId = project?.id;

  useEffect(() => {
    if (creating || !projectId) return;
    const controller = new AbortController();
    void projectSuggestions(projectId, controller.signal).then(setSuggestions).catch(() => setSuggestions([]));
    return () => controller.abort();
  }, [creating, projectId]);

  const trimmed = name.trim();
  const submit = () => {
    if (!trimmed) return;
    onSave({ name: trimmed, about: about.trim() || null, ...wordsToFields(words), match: cleanList(match, PROJECT_LIMITS.match) });
  };

  const field = 'h-10 w-full rounded-[var(--ev-r-ctl)] border border-ev-line bg-ev-paper px-3 text-sm text-ev-ink outline-none transition-colors placeholder:text-ev-ink-3 focus:border-ev-coat';
  const label = 'font-round text-[13px] font-bold text-ev-ink';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
      className="flex flex-col gap-4 rounded-[var(--ev-r-panel)] bg-ev-raised p-4 shadow-[0_0_0_0.5px_var(--ev-line-strong),var(--ev-e-2)] sm:p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5" htmlFor={`${ids}-name`}>
          <span className={label}>Name</span>
          <input
            id={`${ids}-name`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={PROJECT_LIMITS.name}
            placeholder="Acme redesign"
            autoFocus
            autoComplete="off"
            className={field}
          />
        </label>
        <label className="flex flex-col gap-1.5" htmlFor={`${ids}-about`}>
          <span className={label}>
            About <span className="font-sans text-[12px] font-normal text-ev-ink-2">optional</span>
          </span>
          <input
            id={`${ids}-about`}
            value={about}
            onChange={(event) => setAbout(event.target.value)}
            maxLength={PROJECT_LIMITS.about}
            placeholder="One line of background for summaries"
            autoComplete="off"
            className={field}
          />
        </label>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-words`} className={label}>Words</label>
        <ChipInput
          id={`${ids}-words`}
          label="Words"
          value={words}
          onChange={setWords}
          max={PROJECT_LIMITS.vocabulary}
          maxLength={PROJECT_LIMITS.term}
          placeholder="Names, people, products, jargon…"
          hint="Spelled exactly like this in transcripts. Press Enter or comma after each, or paste a list."
          suggestions={suggestions}
          suggestionsLabel="From recent recordings:"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-match`} className={label}>
          Pick this project automatically when a window title contains
        </label>
        <ChipInput
          id={`${ids}-match`}
          label="Window title words"
          value={match}
          onChange={setMatch}
          max={PROJECT_LIMITS.match}
          maxLength={PROJECT_LIMITS.term}
          placeholder={trimmed ? `${trimmed} (default)` : 'Repo, folder or client name'}
          hint={
            match.length === 0
              ? `Leave empty to use the project name${trimmed ? `, “${trimmed}”` : ''}. Used by the Mac app.`
              : 'Used by the Mac app, for example a repo name in your editor or terminal.'
          }
          showCount={match.length > 0}
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className={appButton('ghost')}>
          Cancel
        </button>
        <button type="submit" disabled={!trimmed} className={appButton('primary')}>
          {creating || !project ? 'Create project' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
