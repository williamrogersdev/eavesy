'use client';

import { Check, Clipboard, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { copyText } from '@/lib/desktop/bridge';
import { cn } from '@/lib/utils';
import { type MeetingData } from './types';
import { buildContextMd } from './format';

export function CopyContextButton({ data }: { data: MeetingData }) {
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

export function CopyButton({
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
