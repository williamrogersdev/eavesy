'use client';

import { FolderPlus, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  acceptAssistantRuleChange,
  addAssistantRule,
  DEFAULT_ASSISTANT_STYLE,
  discardAssistantRuleChange,
  forgetAllAssistantNotes,
  forgetAssistantNote,
  getAssistantActivity,
  getAssistantMemory,
  getAssistantRules,
  getAssistantState,
  getAssistantVoices,
  keepAssistantMerge,
  openAssistantMemory,
  openAssistantRules,
  onAssistantRules,
  pickFolder,
  removeAssistantRule,
  setAssistantMemory,
  setAssistantMode,
  setAssistantStyle,
  setAssistantVoice,
  setTrustedAgentFolders,
  undoAssistantMerge,
  type AssistantBook,
  type AssistantActivity,
  type AssistantMemory,
  type AssistantRuleChange,
  type AssistantRuleKind,
  type AssistantRules,
  type AssistantState,
  type AssistantStyle,
  type AssistantVoice,
  type Settings,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Button, Card, IconButton, Menu, Row, Segmented, Select, Switch } from './ui';
import { activityLine, modeLabel, ruleChangeLine, sortVoices, toolLabel } from './eavesy-model';
import { formatRelative } from './format';

const PRESETS = [
  { value: 'plain', label: 'Plain' },
  { value: 'eavesy', label: 'Eavesy' },
  { value: 'more', label: 'More character' },
] as const;
const CHATTINESS = [
  { value: 'less', label: 'Shorter' },
  { value: 'default', label: 'Default' },
  { value: 'more', label: 'Fuller' },
] as const;
const WARMTH = [
  { value: 'less', label: 'Drier' },
  { value: 'default', label: 'Default' },
  { value: 'more', label: 'Warmer' },
] as const;
const RATES = [
  { value: 'default', label: 'Normal' },
  { value: '150', label: 'Slower' },
  { value: '210', label: 'Faster' },
  { value: '260', label: 'Fastest' },
] as const;
type Rate = string;
type ModeChoice = 'ask' | 'auto' | 'bypass-hour' | 'bypass';
const MODES: { value: ModeChoice; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypass-hour', label: 'Bypass for an hour' },
  { value: 'bypass', label: 'Bypass until I turn it off' },
];
const SYSTEM_VOICE = '';
const RULE_KINDS: { kind: AssistantRuleKind; label: string; pick: string }[] = [
  { kind: 'remove_worktrees', label: 'Remove finished worktrees under…', pick: 'Remove finished worktrees under this folder without a card' },
  { kind: 'stop_leftovers', label: 'Stop leftover processes under…', pick: 'Stop leftover processes in this folder without a card' },
];
const isCancel = (e: unknown) => errMsg(e, '') === 'cancelled';
/** The caps in desktop assistant/memory.rs. */
const MAX_ABOUT = 20;
const MAX_NOTES = 50;

/** One notebook: its notes, each deletable, with Forget All behind a second click. */
function NoteList({ title, hint, notes, path, book, act }: {
  title: string;
  hint: string;
  notes: string[];
  path: string | null;
  book: AssistantBook;
  act: (run: () => Promise<void>, failed: string) => void;
}) {
  const [confirmForget, setConfirmForget] = useState(false);
  return (
    <div className="ev-set-row flex-col">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="ev-set-label">{title} · {notes.length === 1 ? '1 note' : `${notes.length} notes`}</div>
          <div className="ev-set-hint">{hint}</div>
          {path && <div className="ev-set-hint ev-set-path" title={path}>{path}</div>}
        </div>
        <Button variant="outline" size="sm" onClick={() => act(() => openAssistantMemory(book), 'Couldn’t open the file.')}>Open in Editor</Button>
        {notes.length > 0 && (
          confirmForget
            ? <Button variant="primary" size="sm" onClick={() => { setConfirmForget(false); act(() => forgetAllAssistantNotes(book), 'Couldn’t forget everything.'); }}>Forget All {notes.length}</Button>
            : <Button variant="quiet" size="sm" onClick={() => setConfirmForget(true)}>Forget All…</Button>
        )}
      </div>
      {notes.length > 0 && (
        <ul className="ev-assistant-folders">
          {notes.map((note, index) => (
            <li key={`${index}-${note}`}>
              <span className="ev-set-label ev-assistant-note">{note}</span>
              <IconButton label={`Forget “${note}”`} icon={Trash2} size={24} onClick={() => act(() => forgetAssistantNote(note, book), 'Couldn’t forget that.')} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function modeChoice(state: AssistantState): ModeChoice {
  if (state.effective === 'bypass') return state.until_ms === null ? 'bypass' : 'bypass-hour';
  return state.effective;
}

/**
 * Settings → Assistant (assistant.md G4, G5, C8, C5): how Eavesy talks, its
 * voice, how much it does without asking, and what it has done.
 */
export function AssistantSettings({ active, settings, onSettings }: {
  active: boolean;
  settings: Settings | null;
  onSettings: (change: (current: Settings) => Settings) => void;
}) {
  const style = settings?.assistant_style ?? DEFAULT_ASSISTANT_STYLE;
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<AssistantState | null>(null);
  const [voices, setVoices] = useState<AssistantVoice[] | null>(null);
  const [activity, setActivity] = useState<AssistantActivity[] | null>(null);
  const [loadingActivity, setLoadingActivity] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [memory, setMemory] = useState<AssistantMemory | null>(null);

  const loadState = useCallback(() => getAssistantState().then(setState).catch((e: unknown) => setError(errMsg(e, 'Couldn’t read Eavesy’s mode.'))), []);
  const loadActivity = useCallback(() => {
    setLoadingActivity(true);
    setNow(Date.now());
    void getAssistantActivity(50)
      .then(setActivity)
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t read the activity log.')))
      .finally(() => setLoadingActivity(false));
  }, []);
  // Read each time the section opens, so a mode changed in the panel shows here.
  useEffect(() => {
    if (!active) return;
    void loadState();
    loadActivity();
  }, [active, loadState, loadActivity]);
  const loadMemory = useCallback(() => {
    void getAssistantMemory().then(setMemory).catch((e: unknown) => setError(errMsg(e, 'Couldn’t read Eavesy’s notes.')));
  }, []);
  // Read each time too: memory.md can be edited by hand, and Eavesy adds to it as you talk.
  useEffect(() => {
    if (active) loadMemory();
  }, [active, loadMemory]);
  const memoryAction = (run: () => Promise<void>, failed: string) => {
    setError(null);
    void run().then(loadMemory).catch((e: unknown) => setError(errMsg(e, failed)));
  };
  const toggleMemory = (on: boolean) => {
    setError(null);
    void setAssistantMemory(on)
      .then(() => { onSettings((current) => ({ ...current, assistant_memory: on })); loadMemory(); })
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t change that setting.')));
  };

  const [rules, setRules] = useState<AssistantRules | null>(null);
  const loadRules = useCallback(() => {
    void getAssistantRules().then(setRules).catch((e: unknown) => setError(errMsg(e, 'Couldn’t read the rules.')));
  }, []);
  // Read each time, and again when Eavesy suggests one: rules.md can change by hand.
  useEffect(() => {
    if (!active) return;
    loadRules();
    const off = onAssistantRules(loadRules);
    return () => void off.then((stop) => stop());
  }, [active, loadRules]);
  const ruleAction = (run: () => Promise<AssistantRules>, failed: string) => {
    setError(null);
    void run().then(setRules).catch((e: unknown) => { if (!isCancel(e)) setError(errMsg(e, failed)); loadRules(); });
  };
  const addRule = (kind: AssistantRuleKind, title: string) => {
    void pickFolder(title)
      .then((folder) => { if (folder) ruleAction(() => addAssistantRule(kind, folder), 'Couldn’t add that rule.'); })
      .catch((e: unknown) => { if (!isCancel(e)) setError(errMsg(e, 'Couldn’t open the folder picker.')); });
  };
  const acceptChange = (change: AssistantRuleChange) => ruleAction(() => acceptAssistantRuleChange(change), 'Couldn’t accept that.');
  const discardChange = (change: AssistantRuleChange) => ruleAction(() => discardAssistantRuleChange(change), 'Couldn’t discard that.');

  // Listed afresh each time too, so a voice added in System Settings shows.
  useEffect(() => {
    if (active) void getAssistantVoices().then(setVoices).catch(() => setVoices([]));
  }, [active]);

  const changeStyle = (patch: Partial<AssistantStyle>) => {
    const next = { ...style, ...patch };
    setError(null);
    void setAssistantStyle(next)
      .then(() => onSettings((current) => ({ ...current, assistant_style: next })))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t change how Eavesy talks.')));
  };

  // What you picked last, shown at once; settings catch up when the save lands.
  const [picked, setPicked] = useState<{ name: string; rate: Rate } | null>(null);
  const saved = settings?.assistant_voice ?? SYSTEM_VOICE;
  const savedRate = settings?.assistant_voice_rate;
  // A saved voice this Mac no longer has isn't used: show what will be.
  const voiceName = picked?.name ?? (voices && !voices.some((voice) => voice.name === saved) ? SYSTEM_VOICE : saved);
  const rate: Rate = picked?.rate ?? (savedRate === undefined ? 'default' : String(savedRate));
  // A speed set some other way shows as itself rather than as Normal.
  const rateOptions = RATES.some((option) => option.value === rate) ? RATES : [...RATES, { value: rate, label: `${rate} words a minute` }];
  // Saves run one after another, so an older one can never land last.
  const saving = useRef<Promise<void>>(Promise.resolve());
  const latestPick = useRef(0);
  const voiceOptions = useMemo(() => [
    { value: SYSTEM_VOICE, label: 'System voice' },
    ...sortVoices(voices ?? [], typeof navigator === 'undefined' ? 'en' : navigator.language)
      .map((voice) => ({ value: voice.name, label: `${voice.name} (${voice.locale.replace('_', '-')})` })),
  ], [voices]);
  const changeVoice = (patch: { name?: string; rate?: Rate }) => {
    const next = { name: voiceName, rate, ...patch };
    const pick = ++latestPick.current;
    setPicked(next);
    setError(null);
    const rateValue = next.rate === 'default' ? null : Number(next.rate);
    saving.current = saving.current.then(() => setAssistantVoice(next.name || null, rateValue)
      .then(() => onSettings((current) => ({ ...current, assistant_voice: next.name || undefined, assistant_voice_rate: rateValue ?? undefined })))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t change the voice.')))
      // Once the newest pick has landed (or failed), show the saved settings again.
      .finally(() => { if (latestPick.current === pick) setPicked(null); }));
  };

  const chooseMode = (choice: ModeChoice) => {
    setError(null);
    const [mode, minutes] = choice === 'bypass-hour' ? ['bypass', 60] as const : [choice, null] as const;
    void setAssistantMode(mode, minutes)
      .then(loadState)
      .catch((e: unknown) => { if (errMsg(e, '') !== 'cancelled') setError(errMsg(e, 'Couldn’t change the mode.')); });
  };

  const folders = state?.trusted_folders ?? [];
  const saveFolders = (next: string[]) => {
    setError(null);
    void setTrustedAgentFolders(next)
      .then((saved) => setState((current) => current ? { ...current, trusted_folders: saved } : current))
      .catch((e: unknown) => { if (errMsg(e, '') !== 'cancelled') setError(errMsg(e, 'Couldn’t change the trusted folders.')); });
  };
  const addFolder = () => {
    void pickFolder('Trust local agents working in this folder').then((folder) => {
      if (folder && !folders.includes(folder)) saveFolders([...folders, folder]);
    });
  };

  return (
    <>
      {error && <p role="alert" className="ev-set-hint ev-assistant-error">{error}</p>}
      <Card title="How Eavesy talks">
        <div className="ev-set-row flex-col">
          <div>
            <div className="ev-set-label">Style</div>
            <div className="ev-set-hint">Only the conversation and its voice. Cards, buttons and errors stay plain.</div>
          </div>
          <Segmented label="Eavesy’s style" value={style.preset} onChange={(preset) => changeStyle({ preset })} options={[...PRESETS]} />
        </div>
        <Row label="Chattiness" hint="How much it says beyond the answer.">
          <Segmented label="Chattiness" size="sm" value={style.chattiness} onChange={(chattiness) => changeStyle({ chattiness })} options={[...CHATTINESS]} />
        </Row>
        <Row label="Warmth">
          <Segmented label="Warmth" size="sm" value={style.warmth} onChange={(warmth) => changeStyle({ warmth })} options={[...WARMTH]} />
        </Row>
      </Card>

      <Card title="Voice">
        <Row label="Voice" hint="Add more in System Settings → Accessibility → Spoken Content.">
          <Select label="Eavesy’s voice" value={voiceName} options={voiceOptions} disabled={!settings || voices === null} onChange={(name) => changeVoice({ name })} />
        </Row>
        <Row label="Speed">
          <Select label="How fast Eavesy talks" value={rate} options={rateOptions} disabled={!settings} onChange={(next) => changeVoice({ rate: next })} />
        </Row>
      </Card>

      <Card title="Memory">
        <Switch
          checked={memory?.on ?? settings?.assistant_memory ?? true}
          disabled={!memory}
          onCheckedChange={toggleMemory}
          label="Remember things I ask it to"
          hint="Eavesy keeps short notes when you ask it to remember something, and sends them to its model with each message. Off: no notes are sent or added."
        />
        {memory?.merged && (
          <div className="ev-set-row">
            <div className="min-w-0 flex-1">
              <div className="ev-set-label">Merged {memory.merged.before} notes into {memory.merged.after}</div>
              <div className="ev-set-hint">Your setup notes filled up {formatRelative(memory.merged.at_ms, now)}, so Eavesy merged them to make room.</div>
            </div>
            <Button variant="outline" size="sm" onClick={() => memoryAction(undoAssistantMerge, 'Couldn’t undo the merge.')}>Undo Merge</Button>
            <Button variant="quiet" size="sm" onClick={() => memoryAction(keepAssistantMerge, 'Couldn’t keep the merge.')}>Keep</Button>
          </div>
        )}
        <NoteList
          title="About you"
          hint={`Kept short so you can read it all: ${MAX_ABOUT} at most.`}
          notes={memory?.about ?? []}
          path={memory?.about_path ?? null}
          book="you"
          act={memoryAction}
        />
        <NoteList
          title="Your setup"
          hint={`Tools, projects and how you work. Past ${MAX_NOTES}, Eavesy merges them to make room.`}
          notes={memory?.notes ?? []}
          path={memory?.path ?? null}
          book="setup"
          act={memoryAction}
        />
      </Card>

      <Card title="Permission">
        <Row label="Mode" hint={state?.tampered ? 'Your rules changed outside Eavesy, so it’s on Ask. Choose a mode to confirm.' : 'Ask confirms every send and change. Auto runs safe ones. Bypass skips cards, but never for passwords, secrets or payments.'}>
          <Select label="Permission mode" value={state ? modeChoice(state) : 'ask'} options={MODES} disabled={!state} onChange={chooseMode} />
        </Row>
        {state && state.effective !== 'ask' && state.until_ms !== null && (
          <p className="ev-set-hint">{modeLabel(state, now)} left, then back to Ask.</p>
        )}
        <div className="ev-set-row flex-col">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="ev-set-label">Trusted agent folders</div>
              <div className="ev-set-hint">Outside Ask, local agents working in these folders act as you.</div>
            </div>
            <Button variant="outline" size="sm" disabled={!state} onClick={addFolder}>
              <FolderPlus size={13} strokeWidth={1.75} aria-hidden /> Add Folder
            </Button>
          </div>
          {folders.length > 0 && (
            <ul className="ev-assistant-folders">
              {folders.map((folder) => (
                <li key={folder}>
                  <span className="ev-set-path" title={folder}>{folder}</span>
                  <IconButton label={`Stop trusting ${folder}`} icon={X} size={24} onClick={() => saveFolders(folders.filter((f) => f !== folder))} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <Card title="Rules">
        <div className="ev-set-row flex-col">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="ev-set-label">Always allow</div>
              <div className="ev-set-hint">What Eavesy does without a card when you ask, in any mode. Never for agents, voice in Ask, or changes to connections and rules.</div>
            </div>
            <Menu
              trigger={(
                <Button variant="outline" size="sm" disabled={!rules}>
                  <Plus size={13} strokeWidth={1.75} aria-hidden /> Add Rule
                </Button>
              )}
              items={RULE_KINDS.map(({ kind, label, pick }) => ({ label, onSelect: () => addRule(kind, pick) }))}
            />
          </div>
          {rules && rules.rules.length === 0 && <p className="ev-set-hint ev-assistant-empty">No rules. Everything follows the mode above.</p>}
          {rules && rules.rules.length > 0 && (
            <ul className="ev-assistant-folders">
              {rules.rules.map(({ rule, text }) => (
                <li key={`${rule.kind}-${rule.under}`}>
                  <span className="ev-set-label ev-assistant-note" title={rule.under}>{text}</span>
                  <IconButton label={`Remove the rule “${text}”`} icon={X} size={24} onClick={() => ruleAction(() => removeAssistantRule(rule), 'Couldn’t remove that rule.')} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {rules && rules.pending.length > 0 && (
          <div className="ev-set-row flex-col">
            <div>
              <div className="ev-set-label">Waiting for you</div>
              <div className="ev-set-hint">Changes to rules.md made outside this window, by you, an agent or Eavesy. None apply until you accept them.</div>
            </div>
            <ul className="ev-assistant-review">
              {rules.pending.map((change, index) => (
                <li key={`${change.kind}-${index}`} data-kind={change.kind}>
                  <div className="min-w-0 flex-1">
                    <div className="ev-set-label">{ruleChangeLine(change)}</div>
                    {(change.kind === 'invalid' || change.kind === 'unreadable') && <div className="ev-set-hint">{change.reason}</div>}
                  </div>
                  {(change.kind === 'add' || change.kind === 'remove') && (
                    <Button variant="primary" size="sm" onClick={() => acceptChange(change)}>{change.kind === 'add' ? 'Allow…' : 'Remove'}</Button>
                  )}
                  {change.kind !== 'unreadable' && <Button variant="quiet" size="sm" onClick={() => discardChange(change)}>Discard</Button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="ev-set-row">
          <div className="min-w-0 flex-1">
            {rules?.path && <div className="ev-set-hint ev-set-path" title={rules.path}>{rules.path}</div>}
          </div>
          <Button variant="outline" size="sm" onClick={() => void openAssistantRules().then(loadRules).catch((e: unknown) => setError(errMsg(e, 'Couldn’t open the file.')))}>Open in Editor</Button>
        </div>
      </Card>

      <Card title="Activity">
        <div className="ev-set-row">
          <div className="ev-set-hint min-w-0 flex-1">Everything Eavesy did or asked about, newest first. Kept on this Mac.</div>
          <IconButton label="Refresh the activity" icon={RefreshCw} size={24} disabled={loadingActivity} onClick={loadActivity} />
        </div>
        {activity && activity.length === 0 && <p className="ev-set-hint ev-assistant-empty">Nothing yet.</p>}
        {activity && activity.length > 0 && (
          <ol className="ev-assistant-activity">
            {activity.map((entry, index) => (
              <li key={`${entry.at_ms}-${index}`}>
                <div className="ev-set-label">{entry.summary || toolLabel(entry.tool)}</div>
                <div className="ev-set-hint">{entry.requester} · {toolLabel(entry.tool)} · {activityLine(entry)} · {formatRelative(entry.at_ms, now)}</div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
