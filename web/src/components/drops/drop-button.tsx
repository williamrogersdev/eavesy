'use client';

import {
  Check,
  Copy,
  Download,
  FileText,
  Inbox,
  Loader2,
  Paperclip,
  RotateCw,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type LocalDrop, useDrops } from '@/components/drops/drops-provider';
import { copyDropText, downloadUrl, isPreviewableImage, relativeTime } from '@/lib/drops/client';
import { cn, formatBytes } from '@/lib/utils';

export function DropButton() {
  const { unseen, live, panelOpen, setPanelOpen } = useDrops();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!panelOpen) return;
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPanelOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [panelOpen, setPanelOpen]);

  return (
    <div ref={rootRef} className="shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setPanelOpen(!panelOpen)}
        aria-expanded={panelOpen}
        aria-haspopup="dialog"
        title="Drop — send text or files to your other devices (or just paste anywhere)"
        className={cn(
          'relative flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition',
          panelOpen ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Inbox className="h-4 w-4" />
        <span className="hidden sm:inline">Drop</span>
        {unseen > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-action px-1 text-[10px] font-semibold text-white">
            {unseen > 9 ? '9+' : unseen}
          </span>
        ) : null}
        <span
          aria-hidden
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            live === 'live' ? 'bg-emerald-500' : live === 'connecting' ? 'bg-amber-400' : 'bg-muted-foreground/40',
          )}
        />
      </button>
      {panelOpen ? <DropPanel /> : null}
    </div>
  );
}

function DropPanel() {
  const { items, live, sendText, sendFiles } = useDrops();
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => textareaRef.current?.focus(), []);

  const submit = () => {
    if (!draft.trim()) return;
    sendText(draft);
    setDraft('');
  };

  return (
    <div
      role="dialog"
      aria-label="Drops"
      className="absolute right-3 top-[calc(100%+0.5rem)] z-50 flex max-h-[min(78vh,680px)] w-[min(460px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-background shadow-lg sm:right-4"
    >
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">Send to your devices</p>
          <span className="text-[11px] text-muted-foreground">
            {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline — will catch up'}
          </span>
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            // Pasting files into the box sends them; text pastes into the draft as usual.
            const files = Array.from(e.clipboardData.files);
            if (files.length) {
              e.preventDefault();
              sendFiles(files);
            }
          }}
          rows={3}
          placeholder="Paste or type anything…"
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-action"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-[13px] font-medium text-white hover:bg-action-hover disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" /> Send
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[13px] text-muted-foreground hover:bg-muted"
          >
            <Paperclip className="h-3.5 w-3.5" /> File
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) sendFiles(files);
              e.target.value = '';
            }}
          />
          <span className="ml-auto hidden text-[11px] text-muted-foreground sm:inline">
            ⌘↵ to send · or paste / drop anywhere
          </span>
        </div>
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {items.length === 0 ? (
          <li className="px-3 py-8 text-center text-xs text-muted-foreground">
            Nothing yet. Anything you send shows up on every device you’re signed in on, for 7 days.
          </li>
        ) : (
          items.map((drop) => <DropRow key={drop.id} drop={drop} />)
        )}
      </ul>
    </div>
  );
}

function DropRow({ drop }: { drop: LocalDrop }) {
  const { remove, retry } = useDrops();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [expanded, setExpanded] = useState(false);
  const sending = drop.status === 'sending';
  const failed = drop.status === 'failed';

  const copy = () => {
    copyDropText(drop)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('failed'))
      .finally(() => window.setTimeout(() => setCopyState('idle'), 2000));
  };

  return (
    <li className="group px-3 py-2.5">
      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">{drop.deviceLabel ?? 'Unknown device'}</span>
        <span aria-hidden>·</span>
        <span className="shrink-0">
          {sending
            ? drop.kind === 'file' && drop.progress != null
              ? `Uploading ${Math.round(drop.progress * 100)}%`
              : 'Sending…'
            : failed
              ? 'Not sent'
              : relativeTime(drop.createdAt)}
        </span>
        {drop.kind === 'file' || drop.bytes > 2048 ? (
          <span className="shrink-0">· {formatBytes(drop.bytes)}</span>
        ) : null}
      </div>

      {drop.kind === 'text' ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'block w-full whitespace-pre-wrap break-words text-left text-[13px] leading-snug text-foreground',
            expanded ? 'max-h-72 overflow-y-auto' : 'line-clamp-4',
          )}
        >
          {drop.text ?? drop.preview}
          {drop.text == null && drop.preview && drop.preview.length >= 600 ? '…' : ''}
        </button>
      ) : (
        <div className="flex items-center gap-2">
          {isPreviewableImage(drop) && !sending ? (
            <img
              src={`${drop.contentUrl}?inline`}
              alt=""
              className="h-10 w-10 shrink-0 rounded border border-border object-cover"
            />
          ) : (
            <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-[13px] text-foreground">{drop.filename ?? 'File'}</span>
        </div>
      )}

      {sending && drop.kind === 'file' && drop.progress != null ? (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-action transition-[width]" style={{ width: `${Math.round(drop.progress * 100)}%` }} />
        </div>
      ) : null}

      {failed ? <p className="mt-1 text-xs text-danger">{drop.error}</p> : null}

      <div className="mt-1.5 flex items-center gap-1">
        {sending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : failed ? (
          <RowButton onClick={() => retry(drop.id)} icon={RotateCw} label="Retry" />
        ) : drop.kind === 'text' ? (
          <RowButton
            onClick={copy}
            icon={copyState === 'copied' ? Check : Copy}
            label={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
            primary
          />
        ) : (
          <a
            href={downloadUrl(drop)}
            download={drop.filename ?? true}
            className="flex h-7 items-center gap-1 rounded-md bg-action px-2 text-xs font-medium text-white hover:bg-action-hover"
          >
            <Download className="h-3.5 w-3.5" /> Download
          </a>
        )}
        {!sending ? (
          <button
            type="button"
            onClick={() => remove(drop.id)}
            aria-label={failed ? 'Discard' : 'Delete'}
            className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground focus:opacity-100 group-hover:opacity-100"
          >
            {failed ? <X className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function RowButton({
  onClick,
  icon: Icon,
  label,
  primary,
}: {
  onClick: () => void;
  icon: typeof Copy;
  label: string;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium',
        primary ? 'bg-action text-white hover:bg-action-hover' : 'border border-border text-muted-foreground hover:bg-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );
}
