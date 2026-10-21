'use client';

import { ChevronDown, ChevronRight, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseProject, type ProjectFields, type ProjectSummary } from '@/lib/api/projects';
import { accountCall, errMsg } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';
import { PROJECT_LIMITS } from '@/lib/projects';
import { DICTATION_STYLES, dictationStyle, FOR_AGENTS_HINT, type DictationStyle } from '@/lib/transcription/dictation-style';
import { languageName, NOTES_LANGUAGES } from '@/lib/transcription/language';
import { MAX_VOCABULARY_TERMS } from '@/lib/transcription/vocabulary';
import { Button, Card, IconButton, Switch, TagInput } from './ui';

const SAVE_DELAY_MS = 500;

/** Runs the latest `save` once changes stop for a moment; flushes on unmount. */
function useLaterSave<T>(save: (value: T) => Promise<void>) {
  const timer = useRef<number | null>(null);
  const pending = useRef<{ value: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (next) void saveRef.current(next.value);
  }, []);
  useEffect(() => flush, [flush]);
  return useCallback((value: T) => {
    pending.current = { value };
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  }, [flush]);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function Status({ error }: { error: string | null }) {
  return error ? <p role="alert" className="ev-set-hint mt-2 text-[var(--ev-warn-ink)]">{error}</p> : null;
}

/** The languages you speak, how dictations are written and your custom words: the same settings as eavesy.com. */
export function TranscriptionCard() {
  const [languages, setLanguages] = useState<string[] | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [style, setStyle] = useState<DictationStyle>('natural');
  const [forAgents, setForAgents] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void accountCall('GET', '/api/me')
      .then((me) => {
        if (!isRecord(me)) return;
        setLanguages(strings(me.spokenLanguages));
        setWords(strings(me.customVocabulary));
        setStyle(dictationStyle(me.dictationStyle));
        setForAgents(me.dictationForAgents === true);
      })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your settings.')));
  }, []);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const patch = useCallback((body: Record<string, unknown>) => {
    setError(null);
    const next = queue.current.then(() => accountCall('PATCH', '/api/me', body)).then(() => true, (e: unknown) => {
      if (mounted.current) setError(errMsg(e, 'Couldn’t save that.'));
      return false;
    });
    queue.current = next;
    return next;
  }, []);
  const saveWords = useLaterSave<string[]>(async (next) => { await patch({ customVocabulary: next }); });

  const setSpoken = (next: string[]) => {
    setLanguages(next);
    void patch({ spokenLanguages: next });
  };

  return (
    <Card title="Transcription">
      <div className="ev-set-body flex flex-col gap-4">
        <div className="ev-field">
          <label>Languages you speak</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {(languages ?? []).map((code) => (
              <span key={code} className="ev-tag">
                {languageName(code)}
                <button type="button" aria-label={`Remove ${languageName(code)}`} onClick={() => setSpoken((languages ?? []).filter((c) => c !== code))}>
                  <X size={11} strokeWidth={2.25} aria-hidden />
                </button>
              </span>
            ))}
            <select
              aria-label="Add a language"
              className="ev-field-input ev-field-select"
              disabled={languages === null}
              value=""
              onChange={(e) => { if (e.target.value) setSpoken([...(languages ?? []), e.target.value]); }}
            >
              <option value="">{languages?.length ? 'Add another…' : 'Add a language…'}</option>
              {NOTES_LANGUAGES.filter((l) => !languages?.includes(l.code)).map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </div>
          <p className="ev-set-hint">Leave it empty to detect any language.</p>
        </div>
        <div className="ev-field">
          <label htmlFor="ev-dictation-style">Dictation tone</label>
          <select
            id="ev-dictation-style"
            className="ev-field-input ev-field-select"
            disabled={languages === null}
            value={style}
            onChange={(e) => {
              const next = dictationStyle(e.target.value);
              const previous = style;
              setStyle(next);
              void patch({ dictationStyle: next }).then((saved) => { if (!saved && mounted.current) setStyle(previous); });
            }}
          >
            {DICTATION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          <p className="ev-set-hint">{DICTATION_STYLES.find((s) => s.id === style)?.hint}</p>
        </div>
        <Switch
          checked={forAgents}
          disabled={languages === null}
          onCheckedChange={(next) => {
            setForAgents(next);
            void patch({ dictationForAgents: next }).then((saved) => { if (!saved && mounted.current) setForAgents(!next); });
          }}
          label="Format dictation for AI agents"
          hint={FOR_AGENTS_HINT}
        />
        <div className="ev-field">
          <label>Custom words</label>
          <TagInput
            label="Custom words"
            value={words}
            max={MAX_VOCABULARY_TERMS}
            disabled={languages === null}
            placeholder="Names, products, jargon. Press Enter after each."
            onChange={(next) => { setWords(next); saveWords(next); }}
          />
          <p className="ev-set-hint">Spelled your way in every transcript and dictation.</p>
        </div>
        <Status error={error} />
      </div>
    </Card>
  );
}

function ProjectEditor({ project, onChange, onDelete }: {
  project: ProjectSummary;
  onChange: (fields: ProjectFields) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [about, setAbout] = useState(project.about ?? '');
  useEffect(() => setName(project.name), [project.name]);
  useEffect(() => setAbout(project.about ?? ''), [project.about]);
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <div className="ev-field">
        <label htmlFor={`pn-${project.id}`}>Name</label>
        <input
          id={`pn-${project.id}`}
          className="ev-field-input"
          value={name}
          maxLength={PROJECT_LIMITS.name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name.trim() !== project.name) onChange({ name: name.trim() }); }}
        />
      </div>
      <div className="ev-field">
        <label htmlFor={`pa-${project.id}`}>What it is</label>
        <input
          id={`pa-${project.id}`}
          className="ev-field-input"
          value={about}
          maxLength={PROJECT_LIMITS.about}
          placeholder="One line, like “Mac recorder in Rust and Swift”"
          onChange={(e) => setAbout(e.target.value)}
          onBlur={() => { if (about !== (project.about ?? '')) onChange({ about: about.trim() || null }); }}
        />
      </div>
      <div className="ev-field">
        <label>Words</label>
        <TagInput
          label={`Words for ${project.name}`}
          value={project.vocabulary}
          max={PROJECT_LIMITS.vocabulary}
          placeholder="Names, libraries, people. Press Enter after each."
          onChange={(vocabulary) => onChange({ vocabulary })}
        />
      </div>
      <div className="ev-field">
        <label>Pick it when a window title contains</label>
        <TagInput
          label={`Window titles for ${project.name}`}
          value={project.match}
          max={PROJECT_LIMITS.match}
          placeholder={`${project.name} (the default)`}
          onChange={(match) => onChange({ match })}
        />
      </div>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" icon={Trash2} onClick={onDelete}>Delete project</Button>
      </div>
    </div>
  );
}

/** Projects, made and edited right here: no trip to the website. */
export function ProjectsCard({ onChanged }: { onChanged?: () => void }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void accountCall<{ items?: unknown[] }>('GET', '/api/projects')
      .then((body) => setProjects((body?.items ?? []).map(parseProject).filter((p): p is ProjectSummary => !!p)))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your projects.')));
  }, []);

  const pendingFields = useRef(new Map<string, ProjectFields>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const saveLater = useLaterSave<null>(async () => {
    const batch = [...pendingFields.current];
    pendingFields.current.clear();
    await Promise.all(batch.map(([id, fields]) => accountCall('PATCH', `/api/projects/${id}`, fields)
      .then(() => onChanged?.())
      .catch((e: unknown) => {
        pendingFields.current.set(id, { ...fields, ...pendingFields.current.get(id) });
        if (mounted.current) setError(errMsg(e, 'Couldn’t save that project. It will try again with your next change.'));
      })));
  });
  const change = (id: string, fields: ProjectFields) => {
    setError(null);
    setProjects((list) => list?.map((p) => (p.id === id ? { ...p, ...fields } : p)) ?? list);
    pendingFields.current.set(id, { ...pendingFields.current.get(id), ...fields });
    saveLater(null);
  };

  const create = () => {
    const name = draft?.trim();
    if (!name) return;
    setDraft(null);
    setError(null);
    void accountCall<{ project?: unknown }>('POST', '/api/projects', { name })
      .then((body) => {
        const project = parseProject(body?.project);
        if (!project) return;
        setProjects((list) => [...(list ?? []), project]);
        setOpen(project.id);
        onChanged?.();
      })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t create the project.')));
  };

  const remove = (id: string) => {
    pendingFields.current.delete(id);
    setProjects((list) => list?.filter((p) => p.id !== id) ?? list);
    void accountCall('DELETE', `/api/projects/${id}`)
      .then(() => onChanged?.())
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t delete the project.')));
  };

  return (
    <Card title="Projects">
      {projects?.length === 0 && draft === null && (
        <p className="ev-set-hint px-3 pt-2.5">
          One per codebase or client. Eavesy files recordings under the project of the window you’re in and spells its words right.
        </p>
      )}
      {projects?.map((project) => (
        <div key={project.id} className="ev-projrow">
          <button type="button" className="ev-set-row ev-projrow-head" aria-expanded={open === project.id} onClick={() => setOpen(open === project.id ? null : project.id)}>
            <FolderOpen className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
            <span className="ev-set-label min-w-0 flex-1 truncate">{project.name}</span>
            <span className="ev-set-hint shrink-0">{project.vocabulary.length ? `${project.vocabulary.length} words` : 'No words yet'}</span>
            {open === project.id ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          </button>
          {open === project.id && <ProjectEditor project={project} onChange={(fields) => change(project.id, fields)} onDelete={() => remove(project.id)} />}
        </div>
      ))}
      <div className="ev-set-row">
        {draft === null ? (
          <Button variant="outline" size="sm" icon={Plus} disabled={projects === null} onClick={() => setDraft('')}>New project</Button>
        ) : (
          <>
            <input
              autoFocus
              aria-label="Project name"
              className="ev-field-input flex-1"
              placeholder="Project name, like the repo"
              value={draft}
              maxLength={PROJECT_LIMITS.name}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }}
            />
            <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={create}>Create</Button>
            <IconButton label="Cancel" icon={X} onClick={() => setDraft(null)} />
          </>
        )}
      </div>
      {error && <div className="px-3 pb-2"><Status error={error} /></div>}
    </Card>
  );
}
