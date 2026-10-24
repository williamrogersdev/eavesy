'use client';

import { FolderPlus, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_ASSISTANT_STYLE,
  getAssistantActivity,
  getAssistantState,
  getAssistantVoices,
  pickFolder,
  setAssistantMode,
  setAssistantStyle,
  setAssistantVoice,
  setTrustedAgentFolders,
  type AssistantActivity,
  type AssistantState,
  type AssistantStyle,
  type AssistantVoice,
  type Settings,
} from '@/lib/desktop/bridge';
import { errMsg } from '@/lib/desktop/errors';
import { Button, Card, IconButton, Row, Segmented, Select } from './ui';
import { activityLine, modeLabel, sortVoices, toolLabel } from './eavesy-model';
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
type Rate = (typeof RATES)[number]['value'];
type ModeChoice = 'ask' | 'auto' | 'bypass-hour' | 'bypass';
const MODES: { value: ModeChoice; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'auto', label: 'Auto' },
  { value: 'bypass-hour', label: 'Bypass for an hour' },
  { value: 'bypass', label: 'Bypass until I turn it off' },
];
const SYSTEM_VOICE = '';

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
    if (!voices) void getAssistantVoices().then(setVoices).catch(() => setVoices([]));
  }, [active, loadState, loadActivity, voices]);

  const changeStyle = (patch: Partial<AssistantStyle>) => {
    const next = { ...style, ...patch };
    setError(null);
    void setAssistantStyle(next)
      .then(() => onSettings((current) => ({ ...current, assistant_style: next })))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t change how Eavesy talks.')));
  };

  const voiceName = settings?.assistant_voice ?? SYSTEM_VOICE;
  const rate: Rate = RATES.find((option) => option.value === String(settings?.assistant_voice_rate))?.value ?? 'default';
  const voiceOptions = useMemo(() => [
    { value: SYSTEM_VOICE, label: 'System voice' },
    ...sortVoices(voices ?? [], typeof navigator === 'undefined' ? 'en' : navigator.language)
      .map((voice) => ({ value: voice.name, label: `${voice.name} (${voice.locale.replace('_', '-')})` })),
  ], [voices]);
  const changeVoice = (name: string, nextRate: Rate) => {
    setError(null);
    const rateValue = nextRate === 'default' ? null : Number(nextRate);
    void setAssistantVoice(name || null, rateValue)
      .then(() => onSettings((current) => ({ ...current, assistant_voice: name || undefined, assistant_voice_rate: rateValue ?? undefined })))
      .catch((e: unknown) => setError(errMsg(e, 'Couldn’t change the voice.')));
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
          <Select label="Eavesy’s voice" value={voiceName} options={voiceOptions} disabled={!settings || voices === null} onChange={(name) => changeVoice(name, rate)} />
        </Row>
        <Row label="Speed">
          <Select label="How fast Eavesy talks" value={rate} options={RATES} disabled={!settings} onChange={(next) => changeVoice(voiceName, next)} />
        </Row>
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
