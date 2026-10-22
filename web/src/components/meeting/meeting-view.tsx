'use client';

import { CalendarDays, Check, ChevronLeft, Clock, Download, FolderOpen, Laptop, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLiveTranscript, useMeeting } from '@/lib/api/use-meeting';
import { isDesktop, revealInFinder } from '@/lib/desktop/bridge';
import { applyTranscriptDelta } from '@/lib/transcription/live-transcript';
import { cn, formatDuration } from '@/lib/utils';
import { CALL_PLATFORMS, SOURCE_LABELS } from '@/lib/api/use-library';
import { Link } from '@/components/ui/app-link';
import { Mascot } from '@/components/launcher/ui';
import { KindIcon, kindOf } from '@/components/library/kind';
import { AppAlert, AppPage, appButton } from '@/components/ui/app-page';
import { TranscriptPlayer } from './transcript-player';
import { ProjectPicker } from './project-picker';
import { type MeetingData, type Segment } from './types';
import { BriefControls } from './brief-controls';
import { EditableTitle } from './editable-title';
import { NotesEditor } from './notes-editor';
import { TranscriptSection } from './transcript-section';
import { CopyContextButton } from './copy-buttons';
import { ProcessingProgress } from './processing-progress';
import { MeetingChat } from './meeting-chat';
import { Centered, Section, SubHeading } from './layout';
import { audioUrl } from './format';

export function MeetingView({ meetingId, firstRun = false }: { meetingId: string; firstRun?: boolean }) {
  // Polling is the fallback for when the live stream can't be opened.
  const [streamDown, setStreamDown] = useState(false);
  const { data, loading, error, refresh, mutate } = useMeeting<MeetingData>(meetingId, {
    pollMs: streamDown ? 5_000 : undefined,
    shouldPoll: isMeetingLive,
  });
  const streaming = useLiveTranscript<Segment>(meetingId, {
    enabled: data !== null && isMeetingLive(data),
    since: data?.transcriptCursor ?? 0,
    onDelta: (delta) =>
      mutate((current) => ({
        ...current,
        transcriptCursor: delta.cursor,
        segments: applyTranscriptDelta(current.segments, delta),
      })),
    onChange: refresh,
  });
  useEffect(() => setStreamDown(!streaming), [streaming]);

  if (loading && !data) {
    return <Centered>Loading…</Centered>;
  }
  if (error && !data) {
    return <Centered>Couldn&apos;t load this recording: {error.message}</Centered>;
  }
  if (!data) {
    return <Centered>We couldn&apos;t find that recording.</Centered>;
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

function isMeetingLive(data: MeetingData): boolean {
  return ['recording', 'uploading', 'processing'].includes(data.meeting.status);
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

  const call = meeting.platform ? CALL_PLATFORMS[meeting.platform] : undefined;
  const variant = call ? 'meeting' : 'voice';
  const kind = kindOf(variant);
  const device = meeting.deviceName || (meeting.source ? SOURCE_LABELS[meeting.source] : undefined);
  const started = new Date(meeting.startedAt);
  const hasBrief = Boolean(summary || meeting.summaryOverrideMd);

  return (
    <AppPage width="wide" className="gap-6">
      <div>
        <Link
          href="/app"
          className="inline-flex items-center gap-1 rounded-full py-1 pr-2 font-round text-[13px] font-semibold text-ev-ink-2 hover:text-ev-ink"
        >
          <ChevronLeft className="h-4 w-4" /> Library
        </Link>
        <header className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <span className="mt-0.5 grid h-11 w-11 shrink-0 place-items-center rounded-full bg-ev-coat-soft text-ev-coat">
              <KindIcon item={{ variant }} size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <EditableTitle meetingId={meetingId} initial={meeting.title} onSaved={onSaved} />
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 font-round text-[12.5px] font-semibold text-ev-ink-2">
                <MetaChip>{call ?? kind.label}</MetaChip>
                {Number.isFinite(started.getTime()) ? (
                <MetaChip>
                  <CalendarDays className="h-3.5 w-3.5" />
                  {started.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: started.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}
                  {' · '}
                  {started.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                </MetaChip>
                ) : null}
                {meeting.durationSec ? (
                  <MetaChip>
                    <Clock className="h-3.5 w-3.5" />
                    {formatDuration(meeting.durationSec * 1000)}
                  </MetaChip>
                ) : null}
                {device ? (
                  <MetaChip>
                    <Laptop className="h-3.5 w-3.5" />
                    {device}
                  </MetaChip>
                ) : null}
                <ProjectPicker meetingId={meetingId} projectId={meeting.folderId ?? null} onSaved={onSaved} />
              </div>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:pt-1">
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
      </div>

      {actionError ? <AppAlert>{actionError}</AppAlert> : null}
      {refreshError ? (
        <AppAlert>
          We couldn&apos;t refresh this recording. Your last loaded transcript and brief are still shown.
        </AppAlert>
      ) : null}

      {meeting.status === 'processing' ? (
        <ProcessingProgress
          hasTranscript={segments.length > 0 || Boolean(meeting.transcriptOverrideMd)}
          hasBrief={hasBrief}
        />
      ) : meeting.status === 'recording' && meeting.source === 'bot' ? (
        <AppAlert tone="info">
          The notetaker is in this meeting now. The transcript and brief arrive a few minutes after the call ends.
        </AppAlert>
      ) : meeting.status === 'failed' ? (
        <AppAlert>This one didn&apos;t finish: {meeting.statusError || 'no details were given.'}</AppAlert>
      ) : null}

      {firstRun && meeting.status === 'complete' ? (
        <div role="status" className="flex items-center gap-3 rounded-[var(--ev-r-panel)] bg-ev-manila-soft px-4 py-3 text-sm text-ev-manila-ink">
          <Mascot size={28} state="happy" />
          <p>
            Your first brief is ready. Use <strong>Copy for AI</strong> to paste it into Claude, ChatGPT or Cursor.
          </p>
        </div>
      ) : meeting.statusError && meeting.status !== 'failed' ? (
        <AppAlert tone="info">{meeting.statusError}</AppAlert>
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          {hasBrief || segments.length > 0 ? (
            <Section title="Brief" icon={<Sparkles className="h-4 w-4 text-ev-coat" />}>
              {meeting.summaryOverrideMd ? (
                <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-ev-ink">
                  {meeting.summaryOverrideMd}
                </div>
              ) : summary ? (
                <div className="flex flex-col gap-5">
                  {summary.tldr ? <p className="text-[15px] leading-relaxed text-ev-ink">{summary.tldr}</p> : null}

                  {summary.actionItems.length ? (
                    <div>
                      <SubHeading>Action items</SubHeading>
                      <ul className="space-y-1.5 text-sm">
                        {summary.actionItems.map((a, i) => (
                          <li key={i} className="flex items-start gap-2.5">
                            <span
                              className={cn(
                                'mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full',
                                a.completed ? 'bg-ev-leaf text-ev-paper' : 'shadow-[inset_0_0_0_1.5px_var(--ev-line-strong)]',
                              )}
                            >
                              {a.completed ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : null}
                            </span>
                            <span className={a.completed ? 'text-ev-ink-3 line-through' : 'text-ev-ink'}>
                              {a.owner ? <strong className="font-semibold">{a.owner}: </strong> : null}
                              {a.text}
                              {a.due ? <span className="text-ev-ink-3"> · due {a.due}</span> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {summary.decisions.length ? (
                    <div>
                      <SubHeading>Decisions</SubHeading>
                      <Bullets items={summary.decisions.map((d) => d.text)} />
                    </div>
                  ) : null}

                  {summary.openQuestions.length ? (
                    <div>
                      <SubHeading>Open questions</SubHeading>
                      <Bullets items={summary.openQuestions.map((q) => q.text)} />
                    </div>
                  ) : null}
                </div>
              ) : meeting.status === 'complete' ? (
                <p className="text-sm text-ev-ink-2">No brief was written for this one. Pick a format below and regenerate.</p>
              ) : (
                <p className="text-sm text-ev-ink-2">The brief appears here once the transcript is done.</p>
              )}
              <div className="mt-5 border-t border-ev-line pt-3">
                <BriefControls data={data} meetingId={meetingId} onSaved={onSaved} />
              </div>
            </Section>
          ) : null}

          {!meeting.transcriptOverrideMd ? (
            <TranscriptPlayer
              meetingId={meetingId}
              audioUrl={audioUrl(meeting)}
              lines={segments}
              chapters={summary?.chapters ?? []}
              speakerNamesJson={meeting.speakerNamesJson ?? null}
              agentTranscript={meeting.agentTranscriptMd}
              onChanged={onSaved}
            />
          ) : null}

          <TranscriptSection
            segments={meeting.transcriptOverrideMd ? segments : []}
            overrideMd={meeting.transcriptOverrideMd}
          />
        </div>

        <aside className="flex min-w-0 flex-col gap-5 lg:sticky lg:top-4">
          <MeetingChat
            meetingId={meetingId}
            ready={meeting.status === 'complete' || segments.length > 0}
          />
          <NotesEditor meetingId={meetingId} initial={data.notes?.contentMd ?? ''} />
        </aside>
      </div>
    </AppPage>
  );
}

function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-ev-well px-2.5">{children}</span>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 text-sm text-ev-ink">
      {items.map((text, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-ev-coat" />
          {text}
        </li>
      ))}
    </ul>
  );
}
