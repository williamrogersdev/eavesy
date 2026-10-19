'use client';

import { CheckCircle2, Download, FolderOpen, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLiveTranscript, useMeeting } from '@/lib/api/use-meeting';
import { isDesktop, revealInFinder } from '@/lib/desktop/bridge';
import { applyTranscriptDelta } from '@/lib/transcription/live-transcript';
import { formatDuration } from '@/lib/utils';
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
import { Centered, Section } from './layout';
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

  return (
    <AppPage width="reading">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <EditableTitle meetingId={meetingId} initial={meeting.title} onSaved={onSaved} />
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>
              {new Date(meeting.startedAt).toLocaleString()}
              {meeting.durationSec ? ` · ${formatDuration(meeting.durationSec * 1000)}` : ''}
              {meeting.platform ? ` · ${meeting.platform}` : ''}
            </span>
            <ProjectPicker meetingId={meetingId} projectId={meeting.folderId ?? null} onSaved={onSaved} />
          </div>
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
        agentTranscript={meeting.agentTranscriptMd}
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
