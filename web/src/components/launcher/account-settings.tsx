'use client';

import { ArrowLeft, ChevronRight, FolderOpen, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseProject, type ProjectFields, type ProjectSummary } from '@/lib/api/projects';
import { accountCall, errMsg } from '@/lib/desktop/bridge';
import { isRecord } from '@/lib/json';
import { PROJECT_LIMITS } from '@/lib/projects';
import { DICTATION_STYLES, dictationStyle, FOR_AGENTS_HINT, isDictationStyle, type DictationStyle } from '@/lib/transcription/dictation-style';
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

/** Loads the account's settings once and saves changes in order, putting a field back when its save fails. */
export function useAccountPrefs() {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [prefs, setPrefs] = useState<AccountPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void accountCall('GET', '/api/me')
      .then((me) => {
        if (!isRecord(me)) return;
        setPrefs({
          languages: strings(me.spokenLanguages),
          words: strings(me.customVocabulary),
          style: dictationStyle(me.dictationStyle),
          forAgents: me.dictationForAgents === true,
        });
      })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t load your settings.')));
  }, [loadAttempt]);

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

/** How dictations are written, for every project that doesn't choose its own. */
export function DictationCard({ account }: { account: AccountPrefsState }) {
  const { prefs, update } = account;
  const style = prefs?.style ?? 'natural';
  return (
    <Card title="Writing">
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
          checked={prefs?.forAgents ?? false}
          disabled={!prefs}
          onCheckedChange={(next) => update({ forAgents: next }, { dictationForAgents: next })}
          label="Format for AI agents"
          hint={FOR_AGENTS_HINT}
        />
      </div>
      <p className="ev-set-hint px-3 py-2.5">The default for every dictation. A project can choose its own, under Projects.</p>
    </Card>
  );
}

/** The languages you speak and your custom words: the same settings as eavesy.com. */
export function TranscriptionCard() {
  const [languages, setLanguages] = useState<string[] | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [baseline, setBaseline] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await accountCall('GET', '/api/me');
      if (!isRecord(me)) throw new Error('Unexpected account response');
      const nextLanguages = strings(me.spokenLanguages);
      const nextWords = strings(me.customVocabulary);
      setLanguages(nextLanguages);
      setWords(nextWords);
      setBaseline(JSON.stringify([nextLanguages, nextWords]));
    } catch {
      setError('Transcription preferences could not be loaded from eavesy.com. Check your connection and try again. Settings on this Mac still work.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const dirty = languages !== null && JSON.stringify([languages, words]) !== baseline;
  const save = async () => {
    if (languages === null || saving) return;
    setSaving(true); setError(null); setSaved(null);
    try {
      await accountCall('PATCH', '/api/me', { spokenLanguages: languages, customVocabulary: words });
      setBaseline(JSON.stringify([languages, words]));
      setSaved('Changes saved');
    } catch {
      setError('These changes could not be saved to eavesy.com. Your draft is still here. Check your connection, then save again.');
    } finally { setSaving(false); }
  };

  return (
    <Card title="Transcription">
      <div className="ev-set-body flex flex-col gap-4">
        <div className="ev-field">
          <label htmlFor="settings-spoken-language">Languages you speak</label>
          <div className="flex flex-wrap items-center gap-1.5">
            {(languages ?? []).map((code) => (
              <span key={code} className="ev-tag">
                {languageName(code)}
                <button type="button" disabled={saving} aria-label={`Remove ${languageName(code)}`} onClick={() => { setLanguages((languages ?? []).filter((c) => c !== code)); setSaved(null); }}>
                  <X size={11} strokeWidth={2.25} aria-hidden />
                </button>
              </span>
            ))}
            <select
              aria-label="Add a language"
              id="settings-spoken-language"
              className="ev-field-input ev-field-select"
              disabled={languages === null || saving}
              value=""
              onChange={(e) => { if (e.target.value) { setLanguages([...(languages ?? []), e.target.value]); setSaved(null); } }}
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
          <span className="ev-set-label">Custom words</span>
          <TagInput
            label="Custom words"
            value={words}
            max={MAX_VOCABULARY_TERMS}
            disabled={languages === null || saving}
            placeholder="Add a name, product, or phrase…"
            onChange={(next) => { setWords(next); setSaved(null); }}
          />
          <p className="ev-set-hint">Press Enter after each word, or paste a list. Used in transcripts and dictation.</p>
        </div>
        {loading && <p role="status" className="ev-set-hint">Loading your preferences…</p>}
        {error && <div role="alert" className="ev-settings-feedback"><p>{error}</p>{languages === null && <Button variant="outline" size="sm" loading={loading} onClick={() => void load()}>Retry</Button>}</div>}
        {languages !== null && <div className="ev-settings-save">
          <p role="status" className="ev-set-hint">{dirty ? 'Unsaved changes' : saved ?? 'Up to date'}</p>
          <Button variant="primary" loading={saving} disabled={!dirty || saving} onClick={() => void save()}>Save changes</Button>
        </div>}
      </div>
    </Card>
  );
}

type AgentsChoice = 'default' | 'on' | 'off';

function agentsChoice(value: boolean | null | undefined): AgentsChoice {
  return value === true ? 'on' : value === false ? 'off' : 'default';
}

function overrideSummary(project: ProjectSummary): string | null {
  const parts = [
    project.dictationStyle ? styleLabel(project.dictationStyle) : null,
    project.dictationForAgents === true ? 'AI format' : project.dictationForAgents === false ? 'No AI format' : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function ProjectPage({ project, account, onChange, onDelete, onBack }: {
  project: ProjectSummary;
  account: AccountPrefs | null;
  onChange: (fields: ProjectFields) => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [about, setAbout] = useState(project.about ?? '');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setName(project.name), [project.name]);
  useEffect(() => setAbout(project.about ?? ''), [project.about]);
  const accountTone = account ? styleLabel(account.style) : '…';
  const accountAgents = account ? (account.forAgents ? 'on' : 'off') : '…';
  return (
    <div className="flex flex-col">
      <div className="mb-3 flex items-center gap-2">
        <IconButton label="All projects" title="All projects" icon={ArrowLeft} onClick={onBack} />
        <h3 className="ev-set-label min-w-0 flex-1 truncate font-semibold">{project.name}</h3>
        <span className="ev-set-hint shrink-0">{project.recordingCount === 1 ? '1 recording' : `${project.recordingCount} recordings`}</span>
      </div>

      <Card title="Details">
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
            <p className="ev-set-hint">Gives transcripts and dictations context, so terms come out right.</p>
          </div>
        </div>
      </Card>

      <Card title="Dictation" className="mt-[18px]">
        <Row
          label="Tone"
          hint={project.dictationStyle ? DICTATION_STYLES.find((s) => s.id === project.dictationStyle)?.hint : 'Same as your account.'}
        >
          <Select
            label="Project dictation tone"
            value={project.dictationStyle ?? 'default'}
            options={[{ value: 'default', label: `Account (${accountTone})` }, ...TONE_OPTIONS]}
            onChange={(next) => onChange({ dictationStyle: isDictationStyle(next) ? next : null })}
          />
        </Row>
        <Row label="Format for AI agents" hint="The ask first, then context and constraints.">
          <Select
            label="Format for AI agents"
            value={agentsChoice(project.dictationForAgents)}
            options={[
              { value: 'default', label: `Account (${accountAgents})` },
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(next) => onChange({ dictationForAgents: next === 'default' ? null : next === 'on' })}
          />
        </Row>
        <p className="ev-set-hint px-3 py-2.5">Applies when you dictate into a window that picks this project.</p>
      </Card>

      <Card title="Words" className="mt-[18px]">
        <div className="ev-set-body flex flex-col gap-1.5">
          <TagInput
            label={`Words for ${project.name}`}
            value={project.vocabulary}
            max={PROJECT_LIMITS.vocabulary}
            placeholder="Names, libraries, people. Press Enter after each."
            onChange={(vocabulary) => onChange({ vocabulary })}
          />
          <p className="ev-set-hint">Spelled this way in this project’s recordings and dictations.</p>
        </div>
      </Card>

      <Card title="Auto-pick" className="mt-[18px]">
        <div className="ev-set-body flex flex-col gap-1.5">
          <TagInput
            label={`Window titles for ${project.name}`}
            value={project.match}
            max={PROJECT_LIMITS.match}
            placeholder={`${project.name} (the default)`}
            onChange={(match) => onChange({ match })}
          />
          <p className="ev-set-hint">Eavesy picks this project when the window you’re in has one of these in its title or app name.</p>
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

/** Projects, made and edited right here: a list, and a page for each. */
export function ProjectsSettings({ account, onChanged }: { account: AccountPrefs | null; onChanged?: () => void }) {
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
    setOpen(null);
    setProjects((list) => list?.filter((p) => p.id !== id) ?? list);
    void accountCall('DELETE', `/api/projects/${id}`)
      .then(() => onChanged?.())
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t delete the project.')));
  };

  const current = projects?.find((p) => p.id === open);
  if (current) {
    return (
      <>
        <ProjectPage project={current} account={account} onChange={(fields) => change(current.id, fields)} onDelete={() => remove(current.id)} onBack={() => setOpen(null)} />
        <Status error={error} />
      </>
    );
  }

  return (
    <Card title="Projects">
      <p className="ev-set-hint px-3 pt-2.5">
        One per codebase or client. Eavesy files recordings under the project of the window you’re in, spells its words right, and can give its dictations their own tone.
      </p>
      {projects?.map((project) => {
        const summary = overrideSummary(project);
        return (
          <div key={project.id} className="ev-projrow">
            <button type="button" className="ev-set-row ev-projrow-head" onClick={() => setOpen(project.id)}>
              <FolderOpen className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="ev-set-label block truncate">{project.name}</span>
                <span className="ev-set-hint block truncate">
                  {[
                    project.vocabulary.length ? `${project.vocabulary.length} words` : 'No words yet',
                    summary ?? 'Account dictation',
                  ].join(' · ')}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ev-ink-3)]" aria-hidden />
            </button>
          </div>
        );
      })}
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
