'use client';

import { Camera, Presentation, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Section } from './layout';
import { type MeetingAttachment } from './types';

const LABEL = { snapshot: 'Shared screen', screenshot: 'Screenshot' } as const;

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * One picture from the meeting, filed in the transcript at its moment like a
 * print clipped into the case file. The time plays the call from there.
 */
export function AttachmentFigure({
  attachment,
  onPlay,
  onOpen,
}: {
  attachment: MeetingAttachment;
  onPlay?: () => void;
  onOpen: () => void;
}) {
  const Icon = attachment.kind === 'snapshot' ? Presentation : Camera;
  const label = LABEL[attachment.kind];
  return (
    <figure className="grid grid-cols-[3.5rem_1fr] gap-x-3 px-2 py-2" data-attachment={attachment.kind}>
      <button
        type="button"
        onClick={onPlay}
        disabled={!onPlay}
        className="self-start pt-0.5 text-left font-round text-xs tabular-nums text-ev-ink-3 enabled:hover:text-ev-coat"
        title={onPlay ? 'Play from here' : undefined}
      >
        {clock(attachment.offsetMs)}
      </button>
      <div className="min-w-0">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-full overflow-hidden rounded-[var(--ev-r-ctl)] bg-ev-manila-soft p-1.5 shadow-[0_0_0_1px_var(--ev-line)] transition hover:shadow-[0_0_0_1px_var(--ev-line-strong),var(--ev-e-2)]"
          aria-label={`Open ${label.toLowerCase()} from ${clock(attachment.offsetMs)}`}
        >
          <img
            src={attachment.url}
            alt={attachment.caption ?? `${label} at ${clock(attachment.offsetMs)}`}
            loading="lazy"
            width={attachment.width ?? undefined}
            height={attachment.height ?? undefined}
            className="h-auto max-h-56 w-auto max-w-full rounded-[calc(var(--ev-r-ctl)-4px)] object-contain"
          />
        </button>
        <figcaption className="mt-1 flex items-center gap-1.5 font-round text-[12px] font-semibold text-ev-manila-ink">
          <Icon className="h-3.5 w-3.5" aria-hidden />
          {label}
          {attachment.caption ? <span className="font-normal text-ev-ink-2">· {attachment.caption}</span> : null}
        </figcaption>
      </div>
    </figure>
  );
}

/** The picture at full size over the page; click or esc puts it away. */
export function AttachmentViewer({ attachment, onClose }: { attachment: MeetingAttachment | null; onClose: () => void }) {
  useEffect(() => {
    if (!attachment) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);
  if (!attachment) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${LABEL[attachment.kind]} at ${clock(attachment.offsetMs)}`}
      className="fixed inset-0 z-50 grid place-items-center bg-[rgb(0_0_0/0.72)] p-4 sm:p-8"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 grid h-9 w-9 place-items-center rounded-full bg-ev-raised text-ev-ink shadow-[var(--ev-e-3)]"
      >
        <X className="h-4 w-4" />
      </button>
      <img
        src={attachment.url}
        alt={attachment.caption ?? LABEL[attachment.kind]}
        className="max-h-full max-w-full rounded-[var(--ev-r-ctl)] object-contain shadow-[var(--ev-e-3)]"
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

/** For a meeting whose transcript isn't shown line by line: the pictures on their own. */
export function AttachmentsSection({ attachments }: { attachments: MeetingAttachment[] }) {
  const [open, setOpen] = useState<MeetingAttachment | null>(null);
  if (attachments.length === 0) return null;
  return (
    <Section title="Shared screens" icon={<Presentation className="h-4 w-4 text-ev-coat" />}>
      <div className="-mx-2">
        {attachments.map((attachment) => (
          <AttachmentFigure key={attachment.id} attachment={attachment} onOpen={() => setOpen(attachment)} />
        ))}
      </div>
      <AttachmentViewer attachment={open} onClose={() => setOpen(null)} />
    </Section>
  );
}
