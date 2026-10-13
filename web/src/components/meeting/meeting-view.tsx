'use client';

import {
  Check,
  CheckCircle2,
  Clipboard,
  Download,
  FolderOpen,
  Loader2,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMeeting } from '@/lib/api/use-meeting';
import { copyText, isDesktop, revealInFinder } from '@/lib/desktop/bridge';
import { ANONYMOUS_TOKEN_STORAGE_KEY } from '@/lib/runtime';
import { hasBothSides, parseSpeakerNames, speakerName } from '@/lib/transcription/two-track';
import { cn, formatDuration } from '@/lib/utils';
import { AppAlert, AppPage, appButton } from '@/components/ui/app-page';
import { BRIEF_FORMATS, type BriefFormatId } from '@/lib/brief-formats';
import { isRecord } from '@/lib/json';
import { clockLabel, TranscriptPlayer, type Chapter, type TranscriptLine } from './transcript-player';

type Segment = TranscriptLine;
interface ActionItem {
  text: string;
  owner?: string;
  due?: string;
  completed?: boolean;
}
interface Summary {
  tldr: string;
  decisions: { text: string }[];
  actionItems: ActionItem[];
  openQuestions: { text: string }[];
  chapters?: Chapter[];
}
interface MeetingMeta {
  id: string;
  title: string;
  description?: string | null;
  startedAt: number;
  durationSec?: number | null;
  platform?: string | null;
  status: string;
  statusError?: string | null;
  audioR2Key?: string | null;
  speakerNamesJson?: string | null;
  summaryOverrideMd?: string | null;
  transcriptOverrideMd?: string | null;
}
interface MeetingData {
  meeting: MeetingMeta;
  summary: Summary | null;
  segments: Segment[];
  notes: { contentMd: string } | null;
}

export function MeetingView({ meetingId, firstRun = false }: { meetingId: string; firstRun?: boolean }) {
  const { data, loading, error, refresh } = useMeeting<MeetingData>(meetingId, {
    pollMs: 5_000,
    shouldPoll: isMeetingProcessing,
  });

  if (loading && !data) {
    return <Centered>Loading…</Centered>;
  }
  if (error && !data) {
    return <Centered>Couldn&apos;t load meeting: {error.message}</Centered>;
  }
  if (!data) {
    return <Centered>Meeting not found.</Centered>;
  }

  return (
    <Loaded
      data={data}
      meetingId={meetingId}
      firstRun={firstRun}
      refreshError={error}
      onSaved={refresh}
    />
  );
}

function isMeetingProcessing(data: MeetingData): boolean {
  return data.meeting.status === 'processing';
}

function Loaded({
  data,
  meetingId,
  firstRun,
  refreshError,
  onSaved,
}: {
  data: MeetingData;
  meetingId: string;
  firstRun: boolean;
  refreshError: Error | null;
  onSaved: () => void;
}) {
  const { meeting, summary, segments } = data;
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <AppPage width="reading">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <EditableTitle meetingId={meetingId} initial={meeting.title} onSaved={onSaved} />
          <p className="mt-0.5 text-xs text-muted-foreground">
            {new Date(meeting.startedAt).toLocaleString()}
            {meeting.durationSec ? ` · ${formatDuration(meeting.durationSec * 1000)}` : ''}
            {meeting.platform ? ` · ${meeting.platform}` : ''}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <CopyContextButton data={data} />
          <a
            href={`/api/export/${meeting.id}/zip`}
            className={appButton('secondary', 'sm')}
            title="Download summary, transcript, notes & audio as a .zip"
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </a>
          {isDesktop() ? (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                void revealInFinder(meeting.id).catch((error: unknown) => {
                  setActionError(
                    error instanceof Error ? error.message : 'Could not reveal this meeting in Finder.',
                  );
                });
              }}
              aria-label="Reveal meeting in Finder"
              className={appButton('ghost', 'sm')}
              title="Reveal in Finder"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </header>

      {actionError ? <AppAlert>{actionError}</AppAlert> : null}
      {refreshError ? (
        <AppAlert>
          We couldn&apos;t refresh this recording. Your last loaded transcript and brief are still shown.
        </AppAlert>
      ) : null}

      {meeting.status === 'processing' ? (
        <ProcessingProgress
          hasTranscript={segments.length > 0 || Boolean(meeting.transcriptOverrideMd)}
          hasBrief={Boolean(summary || meeting.summaryOverrideMd)}
        />
      ) : meeting.status === 'failed' ? (
        <AppAlert>Processing failed: {meeting.statusError || 'No additional details were provided.'}</AppAlert>
      ) : null}

      {firstRun && meeting.status === 'complete' ? (
        <div role="status" className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p>
            Your first brief is ready. Use <strong>Copy for AI</strong> to paste it into Claude, ChatGPT or Cursor.
          </p>
        </div>
      ) : meeting.statusError ? (
        <AppAlert tone="info">{meeting.statusError}</AppAlert>
      ) : null}

      {(summary || meeting.summaryOverrideMd || segments.length > 0) ? (
        <BriefControls data={data} meetingId={meetingId} onSaved={onSaved} />
      ) : null}

      {meeting.summaryOverrideMd ? (
        <Section title="Edited brief">
          <pre className="whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-4 font-sans text-sm leading-relaxed">
            {meeting.summaryOverrideMd}
          </pre>
        </Section>
      ) : summary ? (
        <>
          {summary.tldr ? <Section title="TL;DR"><p className="text-sm leading-relaxed">{summary.tldr}</p></Section> : null}

          {summary.decisions.length ? (
            <Section title="Decisions">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {summary.decisions.map((d, i) => (
                  <li key={i}>{d.text}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          {summary.actionItems.length ? (
            <Section title="Action items">
              <ul className="space-y-1.5 text-sm">
                {summary.actionItems.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <CheckCircle2
                      className={`mt-0.5 h-4 w-4 shrink-0 ${a.completed ? 'text-accent' : 'text-muted-foreground/40'}`}
                    />
                    <span className={a.completed ? 'text-muted-foreground line-through' : ''}>
                      {a.owner ? <strong>{a.owner}: </strong> : null}
                      {a.text}
                      {a.due ? <em className="text-muted-foreground"> (due {a.due})</em> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}

          {summary.openQuestions.length ? (
            <Section title="Open questions">
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {summary.openQuestions.map((q, i) => (
                  <li key={i}>{q.text}</li>
                ))}
              </ul>
            </Section>
          ) : null}
        </>
      ) : meeting.status === 'complete' ? (
        <p className="text-sm text-muted-foreground">No summary was generated for this recording.</p>
      ) : null}

      {!meeting.transcriptOverrideMd ? <TranscriptPlayer
        meetingId={meetingId}
        audioUrl={audioUrl(meeting)}
        lines={segments}
        chapters={summary?.chapters ?? []}
        speakerNamesJson={meeting.speakerNamesJson ?? null}
        onChanged={onSaved}
      /> : null}

      <MeetingChat
        meetingId={meetingId}
        ready={meeting.status === 'complete' || segments.length > 0}
      />

      <NotesEditor meetingId={meetingId} initial={data.notes?.contentMd ?? ''} />

      <TranscriptSection
        segments={meeting.transcriptOverrideMd ? segments : []}
        overrideMd={meeting.transcriptOverrideMd}
      />
    </AppPage>
  );
}

interface BriefTemplate {
  id: string;
  name: string;
}

function BriefControls({
  data,
  meetingId,
  onSaved,
}: {
  data: MeetingData;
  meetingId: string;
  onSaved: () => void;
}) {
  const [templates, setTemplates] = useState<BriefTemplate[]>([]);
  const [selection, setSelection] = useState<BriefFormatId | `template:${string}`>('standard');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'save' | 'regenerate' | 'revert' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/templates', { signal: controller.signal })
      .then(async (response): Promise<unknown> => response.ok ? response.json() : null)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!isRecord(value) || !Array.isArray(value.items)) return;
        setTemplates(value.items.flatMap((item): BriefTemplate[] => {
          if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return [];
          if (item.appliesTo !== 'meeting' && item.appliesTo !== 'both') return [];
          return [{ id: item.id, name: item.name }];
        }));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const startEditing = () => {
    setDraft(buildBriefMarkdown(data));
    setMessage(null);
    setEditing(true);
  };

  const save = async () => {
    if (!draft.trim()) return;
    setBusy('save');
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/brief`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentMd: draft }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setEditing(false);
      setMessage('Edited brief saved.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save the edited brief.');
    } finally {
      setBusy(null);
    }
  };

  const revert = async () => {
    setBusy('revert');
    setMessage(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}/brief`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setMessage('Showing the generated brief again.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not restore the generated brief.');
    } finally {
      setBusy(null);
    }
  };

  const regenerate = async () => {
    if (data.meeting.summaryOverrideMd && !confirmReplace) {
      setConfirmReplace(true);
      setMessage('Regenerating will replace your edited brief. Click again to confirm.');
      return;
    }
    setBusy('regenerate');
    setMessage(null);
    try {
      const custom = selection.startsWith('template:') ? selection.slice('template:'.length) : undefined;
      const response = await fetch(`/api/meetings/${meetingId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          format: custom ? 'standard' : selection,
          templateId: custom,
        }),
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = isRecord(result) && typeof result.message === 'string'
          ? result.message
          : `Server returned ${response.status}`;
        throw new Error(detail);
      }
      setConfirmReplace(false);
      setMessage('Brief regenerated.');
      onSaved();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not regenerate the brief.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-label="Brief controls" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={selection}
          onChange={(event) => {
            setSelection(event.target.value as BriefFormatId | `template:${string}`);
            setConfirmReplace(false);
          }}
          aria-label="Brief format"
          className="h-8 rounded-md border border-border bg-background px-2 text-[13px]"
        >
          {BRIEF_FORMATS.map((format) => <option key={format.id} value={format.id}>{format.name}</option>)}
          {templates.length ? <optgroup label="My templates">
            {templates.map((template) => <option key={template.id} value={`template:${template.id}`}>{template.name}</option>)}
          </optgroup> : null}
        </select>
        <button
          type="button"
          onClick={() => void regenerate()}
          disabled={busy !== null}
          className={appButton('ghost', 'sm')}
          title="Rewrite the brief in the selected format"
        >
          {busy === 'regenerate' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {confirmReplace ? 'Confirm replace' : 'Regenerate'}
        </button>
        <button
          type="button"
          onClick={startEditing}
          disabled={busy !== null || editing}
          className={appButton('ghost', 'sm')}
        >
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        {data.meeting.summaryOverrideMd ? (
          <button type="button" onClick={() => void revert()} disabled={busy !== null} className={appButton('ghost', 'sm')}>
            {busy === 'revert' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Restore generated
          </button>
        ) : null}
        {message ? <p aria-live="polite" className="text-xs text-muted-foreground">{message}</p> : null}
      </div>

      {editing ? (
        <div>
          <label htmlFor="brief-markdown" className="sr-only">Brief Markdown</label>
          <textarea
            id="brief-markdown"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={16}
            className="w-full rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed outline-none focus:border-accent/50"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            <button type="button" onClick={() => setEditing(false)} className={appButton('ghost', 'sm')}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy !== null || !draft.trim()} className={appButton('primary', 'sm')}>
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EditableTitle({
  meetingId,
  initial,
  onSaved,
}: {
  meetingId: string;
  initial: string;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editing = draft !== null;

  async function commit() {
    const title = (draft ?? '').trim();
    setDraft(null);
    if (!title || title === initial) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`/api/meetings/${meetingId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      onSaved();
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : 'Could not rename meeting');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        className="w-full rounded-md border border-accent/50 bg-background px-2 py-0.5 text-xl font-semibold tracking-tight outline-none"
      />
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setDraft(initial)}
        className="group flex max-w-full items-start gap-2 text-left"
        title="Rename"
      >
        <h1 className="min-w-0 break-words text-xl font-semibold tracking-tight">{initial}</h1>
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : (
          <Pencil className="h-4 w-4 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
        )}
      </button>
      {saveError ? <p className="mt-1 text-xs text-danger">{saveError}</p> : null}
    </div>
  );
}

function NotesEditor({ meetingId, initial }: { meetingId: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const seeded = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!seeded.current && initial) {
      setValue(initial);
      seeded.current = true;
    }
  }, [initial]);

  const save = useCallback(
    async (md: string) => {
      setStatus('saving');
      try {
        const response = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ meetingId, contentMd: md }),
        });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        setStatus('saved');
        window.setTimeout(() => setStatus('idle'), 1500);
      } catch {
        setStatus('error');
      }
    },
    [meetingId],
  );

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    seeded.current = true;
    const v = e.target.value;
    setValue(v);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save(v), 800);
  }

  return (
    <Section
      title="My notes"
      action={
        status === 'saving' ? (
          <span className="text-xs text-muted-foreground">Saving…</span>
        ) : status === 'saved' ? (
          <span className="inline-flex items-center gap-1 text-xs text-accent">
            <Check className="h-3 w-3" /> Saved
          </span>
        ) : status === 'error' ? (
          <button type="button" onClick={() => void save(value)} className="text-xs font-medium text-danger hover:underline">
            Not saved · Retry
          </button>
        ) : null
      }
    >
      <textarea
        value={value}
        onChange={onChange}
        onBlur={() => {
          if (timer.current) window.clearTimeout(timer.current);
          void save(value);
        }}
        rows={5}
        placeholder="Add your own notes — they're saved to this meeting and included when you export."
        className="w-full rounded-md border border-border bg-background p-3 text-sm leading-relaxed outline-none focus:border-accent/50"
      />
    </Section>
  );
}

function TranscriptSection({
  segments,
  overrideMd,
}: {
  segments: Segment[];
  overrideMd?: string | null;
}) {
  if (overrideMd) {
    return (
      <Section title="Edited transcript" action={<CopyButton text={overrideMd} label="Copy transcript" />}>
        <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-4 font-sans text-sm leading-relaxed">
          {overrideMd}
        </pre>
      </Section>
    );
  }
  if (!segments?.length) return null;

  const text = segments
    .map((s) => `${s.speakerId ? speakerName(s.speakerId, {}) + ': ' : ''}${s.text}`)
    .join('\n');

  return (
    <Section
      title="Transcript"
      action={
        <CopyButton text={text} label="Copy transcript" />
      }
    >
      <div className="max-h-96 space-y-2 overflow-y-auto rounded-md border border-border bg-muted/20 p-4 text-sm leading-relaxed">
        {segments.map((s, i) => (
          <p key={i}>
            {s.speakerId ? <strong className="mr-1">{speakerName(s.speakerId, {})}:</strong> : null}
            {s.text}
          </p>
        ))}
      </div>
    </Section>
  );
}

function CopyContextButton({ data }: { data: MeetingData }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const md = buildContextMd(data);
  const hasUsefulContext = Boolean(
    data.meeting.summaryOverrideMd?.trim() ||
      data.meeting.transcriptOverrideMd?.trim() ||
      data.summary ||
      data.segments.length,
  );
  const processing = ['recording', 'queued', 'uploading', 'processing'].includes(
    data.meeting.status,
  );
  const ready = !processing && hasUsefulContext;
  const unavailableLabel = processing ? 'Brief processing…' : 'No brief to copy';
  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => {
        setFailed(false);
        void copyText(md)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
            void fetch(`/api/meetings/${data.meeting.id}/copy`, { method: 'POST' }).catch(
              () => undefined,
            );
          })
          .catch(() => setFailed(true));
      }}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-white transition',
        failed
          ? 'bg-danger hover:brightness-105'
          : 'bg-accent hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-muted-foreground/45',
      )}
      title={ready
        ? 'Copy summary, notes & transcript as Markdown — paste into Claude or any AI'
        : processing
          ? 'Your AI-ready brief will be copyable when processing finishes'
          : 'No transcript or brief is available to copy'}
    >
      {!ready && processing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Clipboard className="h-3.5 w-3.5" />
      )}
      {!ready
        ? unavailableLabel
        : failed
          ? 'Copy failed'
          : copied
            ? 'Copied'
            : 'Copy for AI'}
    </button>
  );
}

function ProcessingProgress({
  hasTranscript,
  hasBrief,
}: {
  hasTranscript: boolean;
  hasBrief: boolean;
}) {
  const steps = [
    { label: 'Recording saved', done: true, active: false },
    { label: 'Creating transcript', done: hasTranscript, active: !hasTranscript },
    { label: 'Building your brief', done: hasBrief, active: hasTranscript && !hasBrief },
  ];
  return (
    <div role="status" aria-label="Recording processing progress" className="rounded-md border border-border bg-muted/30 px-3 py-2.5">
      <p className="text-sm font-medium">Your recording is safe. Eavesy is finishing the useful part.</p>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-3">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2 text-xs text-muted-foreground">
            {step.done ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-accent" />
            ) : step.active ? (
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
            ) : (
              <span className="h-4 w-4 shrink-0 rounded-full border border-border" />
            )}
            {step.label}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-muted-foreground">You can leave this page; processing continues automatically.</p>
    </div>
  );
}

function CopyButton({
  text,
  label,
}: {
  text: string;
  label: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        setFailed(false);
        void copyText(text)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => setFailed(true));
      }}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Clipboard className="h-3 w-3" />}
      {failed ? 'Copy failed' : copied ? 'Copied' : label}
    </button>
  );
}

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

const CHAT_SUGGESTIONS = [
  'Summarize the key decisions',
  'What are my action items?',
  'Draft a follow-up email',
];

function MeetingChat({ meetingId, ready }: { meetingId: string; ready: boolean }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || busy) return;
      setError(null);
      const next: ChatMsg[] = [...messages, { role: 'user', content }];
      setMessages(next);
      setInput('');
      setBusy(true);
      try {
        const token =
          typeof window !== 'undefined'
            ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY)
            : null;
        const res = await fetch(`/api/meetings/${meetingId}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ messages: next, anonymousSessionToken: token ?? undefined }),
        });
        const json = (await res.json().catch(() => ({}))) as { reply?: string; error?: string; message?: string };
        if (!res.ok) throw new Error(json.message || json.error || 'Chat failed');
        setMessages((m) => [...m, { role: 'assistant', content: String(json.reply ?? '') }]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Chat failed');
      } finally {
        setBusy(false);
      }
    },
    [messages, busy, meetingId],
  );

  return (
    <Section title="Ask">
      <div className="rounded-lg border border-border">
        {messages.length === 0 ? (
          <div className="p-3">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Sparkles className="h-4 w-4 text-accent" />
              Ask anything about this recording — answers are grounded in its transcript.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {CHAT_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => void send(s)}
                  className="h-7 rounded-full border border-border bg-background px-2.5 text-xs transition hover:border-accent/50 hover:text-accent disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div ref={scrollRef} className="max-h-96 space-y-2.5 overflow-y-auto p-3">
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={cn(
                    'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                    m.role === 'user' ? 'bg-action text-white' : 'border border-border bg-background',
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {busy ? (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl border border-border bg-background px-3.5 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
                </div>
              </div>
            ) : null}
          </div>
        )}

        {error ? <p className="px-3 pb-2 text-xs text-danger">{error}</p> : null}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex items-center gap-1.5 border-t border-border p-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={ready ? 'Ask about this meeting…' : 'Available once processing finishes…'}
            aria-label="Ask a question about this meeting"
            disabled={!ready || busy}
            className="h-8 min-w-0 flex-1 rounded-md bg-transparent px-2 text-sm outline-none focus:border-accent/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!ready || busy || !input.trim()}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-action text-white transition hover:bg-action-hover disabled:opacity-50"
            aria-label="Send"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </form>
      </div>
    </Section>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h2>
        {action}
      </div>
      <div>{children}</div>
    </section>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function audioUrl(meeting: MeetingMeta): string | null {
  if (!meeting.audioR2Key) return null;
  const token = typeof window !== 'undefined' ? window.localStorage.getItem(ANONYMOUS_TOKEN_STORAGE_KEY) : null;
  return `/api/audio/${meeting.audioR2Key}${token ? `?anonymousSessionToken=${encodeURIComponent(token)}` : ''}`;
}

function buildContextMd(data: MeetingData): string {
  const { meeting, summary, segments, notes } = data;
  const out: string[] = [`# ${meeting.title}`, '', `_${new Date(meeting.startedAt).toLocaleString()}_`, ''];
  if (meeting.summaryOverrideMd?.trim()) {
    out.push(meeting.summaryOverrideMd.trim(), '');
  } else if (summary?.tldr) out.push('## TL;DR', summary.tldr, '');
  if (!meeting.summaryOverrideMd && summary?.decisions?.length) {
    out.push('## Decisions');
    summary.decisions.forEach((d) => out.push(`- ${d.text}`));
    out.push('');
  }
  if (!meeting.summaryOverrideMd && summary?.actionItems?.length) {
    out.push('## Action items');
    summary.actionItems.forEach((a) =>
      out.push(`- [${a.completed ? 'x' : ' '}] ${a.owner ? a.owner + ': ' : ''}${a.text}${a.due ? ` (due ${a.due})` : ''}`),
    );
    out.push('');
  }
  if (!meeting.summaryOverrideMd && summary?.openQuestions?.length) {
    out.push('## Open questions');
    summary.openQuestions.forEach((q) => out.push(`- ${q.text}`));
    out.push('');
  }
  if (notes?.contentMd?.trim()) out.push('## My notes', notes.contentMd.trim(), '');
  if (summary?.chapters?.length) {
    out.push('## Chapters');
    summary.chapters.forEach((c) => out.push(`- [${clockLabel(c.startMs)}] ${c.title}`));
    out.push('');
  }
  if (meeting.transcriptOverrideMd?.trim()) {
    out.push(meeting.transcriptOverrideMd.trim());
  } else if (segments?.length) {
    const labelled = hasBothSides(segments.map((s) => ({ speakerId: s.speakerId ?? null })));
    const names = parseSpeakerNames(meeting.speakerNamesJson);
    out.push('## Transcript');
    segments.forEach((s) => {
      const who = labelled && s.speakerId ? `${speakerName(s.speakerId, names)}: ` : '';
      out.push(`[${clockLabel(s.startMs)}] ${who}${s.text}`);
    });
  }
  return out.join('\n');
}

function buildBriefMarkdown(data: MeetingData): string {
  if (data.meeting.summaryOverrideMd?.trim()) return data.meeting.summaryOverrideMd;
  const { meeting, summary } = data;
  const out = [`# ${meeting.title}`, ''];
  if (summary?.tldr) out.push('## TL;DR', summary.tldr, '');
  if (summary?.decisions.length) {
    out.push('## Decisions', ...summary.decisions.map((item) => `- ${item.text}`), '');
  }
  if (summary?.actionItems.length) {
    out.push(
      '## Action items',
      ...summary.actionItems.map(
        (item) => `- [${item.completed ? 'x' : ' '}] ${item.owner ? `${item.owner}: ` : ''}${item.text}${item.due ? ` (due ${item.due})` : ''}`,
      ),
      '',
    );
  }
  if (summary?.openQuestions.length) {
    out.push('## Open questions', ...summary.openQuestions.map((item) => `- ${item.text}`), '');
  }
  return out.join('\n').trimEnd();
}
