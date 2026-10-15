'use client';

import { FileText, Mic, Video } from 'lucide-react';
import { type ReactNode } from 'react';
import type { Recording } from '@/lib/launcher/types';
import { cn, formatDuration } from '@/lib/utils';
import { type Command, type Item } from './types';
import { SOURCE_LABEL, formatRelative } from './format';

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

export function RecordButton({
  icon,
  label,
  primary,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium transition-opacity hover:opacity-90"
      style={
        primary
          ? { background: 'var(--lr-brand)', color: '#fff' }
          : {
              border: '1px solid var(--lr-brand)',
              color: 'var(--lr-brand)',
              background: 'var(--lr-brand-soft)',
            }
      }
    >
      {icon}
      {label}
    </button>
  );
}

export function ToolbarBtn({
  title,
  active,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={cn(
        'grid h-8 w-8 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:text-foreground',
        active ? 'text-foreground' : '',
      )}
      style={
        active
          ? { background: 'var(--lr-brand-soft)', color: 'var(--lr-brand)' }
          : { background: 'color-mix(in srgb, var(--background) 60%, transparent)' }
      }
    >
      {children}
    </button>
  );
}

export function Row({
  item,
  active,
  idx,
  now,
  onClick,
  onDoubleClick,
}: {
  item: Item;
  active: boolean;
  idx: number;
  now: number;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const title = item.kind === 'command' ? item.title : item.rec.title;
  const icon =
    item.kind === 'command' ? (
      item.icon
    ) : item.rec.hasVideo || item.rec.source === 'screen' ? (
      <Video className="h-4 w-4" />
    ) : item.rec.source === 'dictation' ? (
      <Mic className="h-4 w-4" />
    ) : (
      <FileText className="h-4 w-4" />
    );
  const subtitle =
    item.kind === 'command'
      ? item.subtitle
      : `${SOURCE_LABEL[item.rec.source]} · ${formatDuration(item.rec.durationSec * 1000)}`;

  return (
    <button
      type="button"
      data-idx={idx}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex w-full items-center gap-3 px-3 py-2 text-left',
        active ? 'lr-row-active' : 'hover:bg-[var(--lr-hover)]',
      )}
    >
      <span
        className={cn(
          'grid h-8 w-8 shrink-0 place-items-center rounded-lg',
          item.kind === 'command'
            ? 'bg-[var(--lr-brand-soft)] text-[var(--lr-brand)]'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-foreground">
          {title}
        </span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {subtitle}
        </span>
      </span>
      {item.kind === 'recording' && (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {item.rec.status === 'recording'
            ? 'live'
            : item.rec.status === 'processing'
              ? 'transcribing…'
              : item.rec.status === 'transcript_failed'
                ? 'no transcript'
                : formatRelative(item.rec.startedAt, now)}
        </span>
      )}
    </button>
  );
}

export function Preview({
  rec,
  command,
  now,
}: {
  rec: Recording | null;
  command: Command | null;
  now: number;
}) {
  if (command) {
    return (
      <div className="launcher-preview min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mb-3 flex items-center gap-2 text-[var(--lr-brand)]">
          {command.icon}
          <span className="text-[15px] font-medium text-foreground">
            {command.title}
          </span>
        </div>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {command.subtitle}
        </p>
      </div>
    );
  }
  if (!rec) {
    return (
      <div className="grid flex-1 place-items-center p-6 text-center text-[13px] text-muted-foreground">
        Select a recording to preview its transcript.
      </div>
    );
  }
  return (
    <div className="launcher-preview min-h-0 overflow-y-auto p-5">
      <h2 className="text-[15px] font-semibold text-foreground">{rec.title}</h2>
      <p className="mt-1 text-[12px] text-muted-foreground">
        {new Date(rec.startedAt).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}{' '}
        · {formatDuration(rec.durationSec * 1000)} · {SOURCE_LABEL[rec.source]}
        {' · '}
        {formatRelative(rec.startedAt, now)}
      </p>
      {rec.summary && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Summary
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            {rec.summary}
          </p>
        </div>
      )}
      {!rec.transcript && rec.status === 'processing' && (
        <div className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground">
          <span
            className="h-2 w-2 animate-recording-pulse rounded-full"
            style={{ background: 'var(--lr-brand)' }}
          />
          Transcribing…
        </div>
      )}
      {!rec.transcript && rec.status === 'transcript_failed' && (
        <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-[12px] leading-relaxed text-muted-foreground">
          Transcript unavailable — transcription failed. The audio is saved
          in your Eavesy folder.
        </div>
      )}
      {rec.transcript && (
        <div className="mt-4">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Transcript
          </p>
          <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
            {rec.transcript}
          </p>
        </div>
      )}
    </div>
  );
}
