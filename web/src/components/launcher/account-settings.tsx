'use client';

import { ArrowLeft, ChevronRight, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseProject, type ProjectFields, type ProjectSummary } from '@/lib/api/projects';
import { accountCall, errMsg } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';
import { PROJECT_LIMITS } from '@/lib/projects';
import { DICTATION_EXAMPLE, DICTATION_STYLES, dictationStyle, effectiveDictation, FOR_AGENTS_HINT, isDictationStyle, type DictationStyle } from '@/lib/transcription/dictation-style';
import { languageName, NOTES_LANGUAGES } from '@/lib/transcription/language';
import { MAX_VOCABULARY_TERMS } from '@/lib/transcription/vocabulary';
import { Button, Card, IconButton, Row, Select, Switch, TagInput } from './ui';

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

function styleLabel(style: DictationStyle): string {
  return DICTATION_STYLES.find((s) => s.id === style)?.label ?? style;
}

const TONE_OPTIONS = DICTATION_STYLES.map((s) => ({ value: s.id, label: s.label }));

/** The account settings shared with eavesy.com: languages, custom words and how dictations are written. */
export interface AccountPrefs {
  languages: string[];
  words: string[];
  style: DictationStyle;
  forAgents: boolean;
}

/**
 * Loads the settings of the account named by `accountKey` (null when signed out),
 * again whenever it changes, and saves changes in order, putting a field back
 * when its save fails.
 */
export function useAccountPrefs(accountKey: string | null) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [prefs, setPrefs] = useState<AccountPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Signed out: nothing to show, and nothing from the last account.
    setPrefs(null);
    setError(null);
    if (accountKey === null) return;
    let live = true;
    void accountCall('GET', '/api/me')
      .then((me) => {
        if (!live || !isRecord(me)) return;
        setPrefs({
          languages: strings(me.spokenLanguages),
          words: strings(me.customVocabulary),
          style: dictationStyle(me.dictationStyle),
          forAgents: me.dictationForAgents === true,
        });
      })
      .catch((e: unknown) => { if (live) setError(errMsg(e, 'Couldn’t load your settings.')); });
    return () => { live = false; };
  }, [accountKey, loadAttempt]);

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

  /** Shows `change` now and saves it; `body` is what the server takes, when it names fields differently. */
  const update = useCallback((change: Partial<AccountPrefs>, body: Record<string, unknown>) => {
    let previous: AccountPrefs | null = null;
    setPrefs((current) => {
      previous = current;
      return current ? { ...current, ...change } : current;
    });
    void patch(body).then((saved) => {
      if (saved || !mounted.current || !previous) return;
      const before = previous;
      setPrefs((current) => current ? { ...current, ...Object.fromEntries(Object.keys(change).map((key) => [key, before[key as keyof AccountPrefs]])) } : current);
    });
  }, [patch]);

  const saveWords = useLaterSave<string[]>(async (next) => { await patch({ customVocabulary: next }); });
  const setWords = useCallback((words: string[]) => {
    setPrefs((current) => current ? { ...current, words } : current);
    saveWords(words);
  }, [saveWords]);

  return { prefs, error, update, setWords, retry: () => { setError(null); setLoadAttempt(value => value + 1); } };
}

type AccountPrefsState = ReturnType<typeof useAccountPrefs>;

/** One spoken sentence and what the chosen style types for it. */
export function StyleExample({ style, forAgents }: { style: DictationStyle; forAgents: boolean }) {
  return (
    <figure className="ev-style-example" aria-label="Example">
      <p className="ev-style-said"><span>You say</span>“{DICTATION_EXAMPLE.said}”</p>
      <p className="ev-style-typed"><span>Eavesy types</span>{(forAgents ? DICTATION_EXAMPLE.forAgents : DICTATION_EXAMPLE.typed)[style]}</p>
    </figure>
  );
}

function ownStyle(project: ProjectSummary): string | null {
  const parts = [
    project.dictationStyle ? styleLabel(project.dictationStyle) : null,
    project.dictationForAgents === true ? 'AI prompt' : project.dictationForAgents === false ? 'not as a prompt' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Your default dictation style, and the projects that write their own way. */
export function DictationCard({ account, projects, onOpenProject }: {
  account: AccountPrefsState;
  projects: ProjectSummary[] | null;
  onOpenProject: (id: string) => void;
}) {
  const { prefs, update, error } = account;
  const style = prefs?.style ?? 'natural';
  const forAgents = prefs?.forAgents ?? false;
  const custom = (projects ?? []).filter((project) => ownStyle(project));
  return (
    <>
      <Card title="Your default style">
        <Row label="Tone" hint={DICTATION_STYLES.find((s) => s.id === style)?.hint}>
          <Select
            label="Dictation tone"
            value={style}
            options={TONE_OPTIONS}
            disabled={!prefs}
            onChange={(next) => update({ style: next }, { dictationStyle: next })}
          />
        </Row>
        <div className="ev-set-row">
          <Switch
            className="w-full"
            checked={forAgents}
            disabled={!prefs}
            onCheckedChange={(next) => update({ forAgents: next }, { dictationForAgents: next })}
            label="Write it as a prompt for AI agents"
            hint={FOR_AGENTS_HINT}
          />
        </div>
        <div className="ev-set-body"><StyleExample style={style} forAgents={forAgents} /></div>
        <Status error={error} />
      </Card>

      <Card title="Projects">
        <p className="ev-set-hint">
          Every dictation uses your default, unless the window you’re in belongs to a project that sets its own style.
        </p>
        {projects === null ? null : custom.length ? (
          <ul className="ev-plain-list">
            {custom.map((project) => (
              <li key={project.id}>
                <button type="button" className="ev-set-row ev-projrow-head" onClick={() => onOpenProject(project.id)}>
                  <FolderOpen className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
                  <span className="ev-set-label min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="ev-set-hint shrink-0">{ownStyle(project)}</span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ev-set-hint">{projects.length ? 'None of your projects set their own style, so they all use this one.' : 'You have no projects yet, so this is used everywhere.'}</p>
        )}
      </Card>
    </>
  );
}

/** The languages you speak, saved as you change them. */
export function LanguagesCard({ account }: { account: AccountPrefsState }) {
  const { prefs, update, error, retry } = account;
  const languages = prefs?.languages ?? [];
  const set = (next: string[]) => update({ languages: next }, { spokenLanguages: next });
  return (
    <Card title="Languages you speak">
      <div className="ev-set-body flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {languages.map((code) => (
            <span key={code} className="ev-tag">
              {languageName(code)}
              <button type="button" aria-label={`Remove ${languageName(code)}`} onClick={() => set(languages.filter((c) => c !== code))}>
                <X size={11} strokeWidth={2.25} aria-hidden />
              </button>
            </span>
          ))}
          <select
            aria-label="Add a language"
            className="ev-field-input ev-field-select"
            disabled={!prefs}
            value=""
            onChange={(e) => { if (e.target.value) set([...languages, e.target.value]); }}
          >
            <option value="">{languages.length ? 'Add another…' : 'Add a language…'}</option>
            {NOTES_LANGUAGES.filter((l) => !languages.includes(l.code)).map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>
        <p className="ev-set-hint">{languages.length ? 'Transcripts listen for these.' : 'None chosen, so Eavesy detects the language each time.'}</p>
        {!prefs && error && <div role="alert" className="ev-settings-feedback"><p>{error}</p><Button variant="outline" size="sm" onClick={retry}>Retry</Button></div>}
        {prefs && <Status error={error} />}
      </div>
    </Card>
  );
}

/** Words to spell your way everywhere: names, products, jargon. */
export function WordsCard({ account }: { account: AccountPrefsState }) {
  const { prefs, setWords } = account;
  return (
    <Card title="Words">
      <div className="ev-set-body flex flex-col gap-2">
        <p className="ev-set-hint">Names, products and jargon Eavesy should listen for and spell exactly like this, in every recording.</p>
        <TagInput
          label="Words"
          value={prefs?.words ?? []}
          max={MAX_VOCABULARY_TERMS}
          disabled={!prefs}
          placeholder="Type a word and press Enter, or paste a list"
          onChange={setWords}
        />
        <p className="ev-set-hint">Click × to remove one. Words for one client or codebase can go on its project instead.</p>
      </div>
    </Card>
  );
}

type AgentsChoice = 'default' | 'on' | 'off';

function agentsChoice(value: boolean | null | undefined): AgentsChoice {
  return value === true ? 'on' : value === false ? 'off' : 'default';
}

/** The projects list, loaded while signed in (and again on retry) and saved a moment after each change. */
export function useProjects(enabled: boolean, onChanged?: () => void) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the list itself couldn't be loaded, so the page can offer Try again.
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) { setProjects(null); setLoadFailed(false); return; }
    let live = true;
    void accountCall<{ items?: unknown[] }>('GET', '/api/projects')
      .then((body) => {
        if (!live) return;
        setProjects((body?.items ?? []).map(parseProject).filter((p): p is ProjectSummary => !!p));
        setLoadFailed(false);
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoadFailed(true);
        setError(errMsg(e, 'Couldn’t load your projects.'));
      });
    return () => { live = false; };
  }, [enabled, attempt]);
  const reload = useCallback(() => { setError(null); setAttempt((n) => n + 1); }, []);

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

  const create = (name: string) => {
    setError(null);
    return accountCall<{ project?: unknown }>('POST', '/api/projects', { name })
      .then((body) => {
        const project = parseProject(body?.project);
        if (!project) return null;
        setProjects((list) => [...(list ?? []), project]);
        onChanged?.();
        return project;
      })
      .catch((e: unknown) => { setError(errMsg(e, 'Couldn’t create the project.')); return null; });
  };

  const remove = (id: string) => {
    pendingFields.current.delete(id);
    const index = projects?.findIndex((p) => p.id === id) ?? -1;
    const removed = index >= 0 ? projects?.[index] : undefined;
    setProjects((list) => list?.filter((p) => p.id !== id) ?? list);
    void accountCall('DELETE', `/api/projects/${id}`)
      .then(() => onChanged?.())
      .catch((e: unknown) => {
        // Put it back where it was, keeping any changes that landed meanwhile.
        if (removed && mounted.current) {
          setProjects((list) => {
            if (!list || list.some((p) => p.id === id)) return list;
            const next = [...list];
            next.splice(Math.min(index, next.length), 0, removed);
            return next;
          });
        }
        if (mounted.current) setError(errMsg(e, 'Couldn’t delete the project.'));
      });
  };

  return { projects, error, loadFailed, reload, change, create, remove };
}

export type ProjectsState = ReturnType<typeof useProjects>;

function autoPickHint(project: ProjectSummary): string {
  return project.match.length
    ? 'Eavesy uses this project when the app or window title you’re in contains any of these.'
    : `None added, so Eavesy looks for “${project.name}” in the app or window title you’re in.`;
}

function ProjectPage({ project, account, onChange, onDelete, onBack, onOpenDictation }: {
  project: ProjectSummary;
  account: AccountPrefs | null;
  onChange: (fields: ProjectFields) => void;
  onDelete: () => void;
  onBack: () => void;
  onOpenDictation: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [about, setAbout] = useState(project.about ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setName(project.name), [project.name]);
  useEffect(() => setAbout(project.about ?? ''), [project.about]);
  const accountTone = account ? styleLabel(account.style) : '…';
  const accountAgents = account ? (account.forAgents ? 'on' : 'off') : '…';
  const effective = effectiveDictation(
    account ? { dictationStyle: account.style, dictationForAgents: account.forAgents } : null,
    project,
  );
  return (
    <div className="flex flex-col">
      <div className="ev-proj-crumbs">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={onBack}>All projects</Button>
        <span className="ev-set-hint ml-auto shrink-0">{project.recordingCount === 1 ? '1 recording' : `${project.recordingCount} recordings`}</span>
      </div>

      <Card title="About">
        <div className="ev-set-body flex flex-col gap-3">
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
            <p className="ev-set-hint">Gives transcripts and dictations context, so its terms come out right.</p>
          </div>
        </div>
      </Card>

      <Card title="Picked automatically when you’re in…">
        <div className="ev-set-body flex flex-col gap-2">
          <TagInput
            label={`Apps or window titles for ${project.name}`}
            value={project.match}
            max={PROJECT_LIMITS.match}
            placeholder={`“${project.name}”, or add words like a repo or client name`}
            onChange={(match) => onChange({ match })}
          />
          <p className="ev-set-hint">{autoPickHint(project)} For example, “acme” matches a window called “Acme homepage – Figma”.</p>
          <p className="ev-set-hint">To choose a project yourself, use the project button in the Eavesy panel.</p>
        </div>
      </Card>

      <Card title="Words">
        <div className="ev-set-body flex flex-col gap-2">
          <TagInput
            label={`Words for ${project.name}`}
            value={project.vocabulary}
            max={PROJECT_LIMITS.vocabulary}
            placeholder="Names, libraries, people. Press Enter after each."
            onChange={(vocabulary) => onChange({ vocabulary })}
          />
          <p className="ev-set-hint">Spelled this way in this project’s recordings and dictations, on top of your own words.</p>
        </div>
      </Card>

      <Card title="Dictation style">
        <Row label="Tone">
          <Select
            label="Project dictation tone"
            value={project.dictationStyle ?? 'default'}
            options={[{ value: 'default', label: `Your default (${accountTone})` }, ...TONE_OPTIONS]}
            onChange={(next) => onChange({ dictationStyle: isDictationStyle(next) ? next : null })}
          />
        </Row>
        <Row label="Write it as a prompt for AI agents">
          <Select
            label="Write it as a prompt for AI agents"
            value={agentsChoice(project.dictationForAgents)}
            options={[
              { value: 'default', label: `Your default (${accountAgents})` },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(next) => onChange({ dictationForAgents: next === 'default' ? null : next === 'on' })}
          />
        </Row>
        <div className="ev-set-body flex flex-col gap-2">
          <StyleExample style={effective.style} forAgents={effective.forAgents} />
          <p className="ev-set-hint">
            Used instead of your default while this project is picked.{' '}
            <button type="button" className="ev-link" onClick={onOpenDictation}>Change your default</button>
          </p>
        </div>
      </Card>

      <div className="mt-4 flex items-center justify-end gap-2">
        {confirmDelete ? (
          <>
            <span className="ev-set-hint">Recordings stay; they just lose the project.</span>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="outline" size="sm" icon={Trash2} onClick={onDelete}>Delete</Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" icon={Trash2} onClick={() => setConfirmDelete(true)}>Delete project</Button>
        )}
      </div>
    </div>
  );
}

/** Projects, made and edited right here: a list, and a page for each. `open` is the project whose page shows. */
export function ProjectsSettings({ account, state, open, onOpen, onOpenDictation }: {
  account: AccountPrefs | null;
  state: ProjectsState;
  open: string | null;
  onOpen: (id: string | null) => void;
  onOpenDictation: () => void;
}) {
  const { projects, error, loadFailed, reload, change, create, remove } = state;
  const [draft, setDraft] = useState<string | null>(null);

  const submit = () => {
    const name = draft?.trim();
    if (!name) return;
    setDraft(null);
    void create(name).then((project) => { if (project) onOpen(project.id); });
  };

  const current = projects?.find((p) => p.id === open);
  if (current) {
    return (
      <>
        <ProjectPage
          project={current}
          account={account}
          onChange={(fields) => change(current.id, fields)}
          onDelete={() => { onOpen(null); remove(current.id); }}
          onBack={() => onOpen(null)}
          onOpenDictation={onOpenDictation}
        />
        <Status error={error} />
      </>
    );
  }

  return (
    <>
      <Card title="How projects work">
        <ol className="ev-howto">
          <li><span><b>Make one for each thing you work on.</b> A repo, a client or a team, with the names and terms that come up.</span></li>
          <li><span><b>Eavesy switches to it on its own.</b> When the window you’re in matches the project, that project is used.</span></li>
          <li><span><b>Your words come out right.</b> Recordings are filed under it, its terms are spelled correctly, and dictation can use its own style.</span></li>
        </ol>
      </Card>
      <Card title="Your projects">
        {projects?.length === 0 && <p className="ev-set-hint">No projects yet.</p>}
        {projects?.map((project) => (
          <div key={project.id} className="ev-projrow">
            <button type="button" className="ev-set-row ev-projrow-head" onClick={() => onOpen(project.id)}>
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="ev-set-label block truncate">{project.name}</span>
                <span className="ev-set-hint block truncate">
                  {[
                    `Used in “${(project.match.length ? project.match : [project.name]).join('”, “')}”`,
                    project.vocabulary.length === 1 ? '1 word' : project.vocabulary.length ? `${project.vocabulary.length} words` : null,
                    ownStyle(project) ?? 'default dictation style',
                  ].filter(Boolean).join(' · ')}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
            </button>
          </div>
        ))}
        {projects === null && loadFailed && (
          <div role="alert" className="ev-settings-feedback">
            <p>{error ?? 'Couldn’t load your projects.'}</p>
            <Button variant="outline" size="sm" onClick={reload}>Try again</Button>
          </div>
        )}
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
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }}
              />
              <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={submit}>Create</Button>
              <IconButton label="Cancel" icon={X} onClick={() => setDraft(null)} />
            </>
          )}
        </div>
        {!(projects === null && loadFailed) && <Status error={error} />}
      </Card>
    </>
  );
}
