'use client';

import { Check, Copy, Download, Upload, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  clientId,
  copyDropText,
  deleteDrop,
  type Drop,
  downloadUrl,
  fetchDrops,
  type HubEvent,
  liveTicket,
  sendText as postText,
  uploadFile,
} from '@/lib/drops/client';
import { cn } from '@/lib/utils';

export type LocalDrop = Drop & {
  status?: 'sending' | 'failed';
  progress?: number;
  error?: string;
};

export type LiveState = 'connecting' | 'live' | 'offline';

interface Toast {
  id: number;
  tone: 'incoming' | 'sent' | 'error';
  message: string;
  drop?: Drop;
}

interface DropsContextValue {
  items: LocalDrop[];
  unseen: number;
  live: LiveState;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  sendText: (text: string) => void;
  sendFiles: (files: File[]) => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}

const DropsContext = createContext<DropsContextValue | null>(null);

export function useDrops(): DropsContextValue {
  const ctx = useContext(DropsContext);
  if (!ctx) throw new Error('useDrops must be used inside <DropsProvider>');
  return ctx;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const PING_MS = 25_000;

let tempSeq = 0;
let toastSeq = 0;

export function DropsProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<LocalDrop[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [live, setLive] = useState<LiveState>('connecting');
  const [panelOpen, setPanelOpenState] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dragging, setDragging] = useState(false);

  const panelOpenRef = useRef(false);
  // Payloads of optimistic items, kept so a failed send can be retried.
  const pendingRef = useRef(new Map<string, { text?: string; file?: File }>());

  const setPanelOpen = useCallback((open: boolean) => {
    panelOpenRef.current = open;
    setPanelOpenState(open);
    if (open) setUnseen(0);
  }, []);

  const pushToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = ++toastSeq;
    setToasts((prev) => [...prev.slice(-2), { ...toast, id }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), toast.tone === 'incoming' ? 10_000 : 4_000);
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const upsert = useCallback((drop: Drop, replaceId?: string) => {
    setItems((prev) => {
      const rest = prev.filter((d) => d.id !== drop.id && d.id !== replaceId);
      return [drop, ...rest].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, []);

  const patch = useCallback((id: string, update: Partial<LocalDrop>) => {
    setItems((prev) => prev.map((d) => (d.id === id ? { ...d, ...update } : d)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const server = await fetchDrops();
      setItems((prev) => {
        const local = prev.filter((d) => d.status);
        return [...local, ...server];
      });
    } catch {
      // Keep what we have; the next refresh or socket event fills the gap.
    }
  }, []);

  // ---- sending ----------------------------------------------------------

  const runText = useCallback(
    async (tempId: string, text: string) => {
      patch(tempId, { status: 'sending', error: undefined });
      try {
        const drop = await postText(text);
        pendingRef.current.delete(tempId);
        upsert(drop, tempId);
        pushToast({ tone: 'sent', message: 'Sent to your devices', drop });
      } catch (err) {
        patch(tempId, { status: 'failed', error: err instanceof Error ? err.message : 'Send failed' });
      }
    },
    [patch, pushToast, upsert],
  );

  const runFile = useCallback(
    async (tempId: string, file: File) => {
      patch(tempId, { status: 'sending', progress: 0, error: undefined });
      try {
        const drop = await uploadFile(file, (progress) => patch(tempId, { progress }));
        pendingRef.current.delete(tempId);
        upsert(drop, tempId);
        pushToast({ tone: 'sent', message: `Sent ${drop.filename ?? 'file'}`, drop });
      } catch (err) {
        patch(tempId, { status: 'failed', error: err instanceof Error ? err.message : 'Upload failed' });
      }
    },
    [patch, pushToast, upsert],
  );

  const sendText = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      const id = `tmp_${++tempSeq}`;
      const bytes = new Blob([text]).size;
      pendingRef.current.set(id, { text });
      upsert({
        ...blankDrop(id),
        kind: 'text',
        text,
        preview: text.slice(0, 600),
        bytes,
        status: 'sending',
      } as LocalDrop);
      void runText(id, text);
    },
    [runText, upsert],
  );

  const sendFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        const id = `tmp_${++tempSeq}`;
        pendingRef.current.set(id, { file });
        upsert({
          ...blankDrop(id),
          kind: 'file',
          filename: file.name,
          contentType: file.type || null,
          bytes: file.size,
          status: 'sending',
          progress: 0,
        } as LocalDrop);
        void runFile(id, file);
      }
    },
    [runFile, upsert],
  );

  const retry = useCallback(
    (id: string) => {
      const pending = pendingRef.current.get(id);
      if (pending?.text != null) void runText(id, pending.text);
      else if (pending?.file) void runFile(id, pending.file);
    },
    [runFile, runText],
  );

  const remove = useCallback(
    (id: string) => {
      let removed: LocalDrop | undefined;
      setItems((prev) => {
        removed = prev.find((d) => d.id === id);
        return prev.filter((d) => d.id !== id);
      });
      if (pendingRef.current.delete(id) || id.startsWith('tmp_')) return;
      deleteDrop(id).catch(() => {
        if (removed) upsert(removed);
        pushToast({ tone: 'error', message: 'Could not delete that drop' });
      });
    },
    [pushToast, upsert],
  );

  // ---- live connection ----------------------------------------------------

  const onEvent = useCallback(
    (event: HubEvent) => {
      if (event.origin === clientId()) return; // Our own write; the POST response already placed it.
      if (event.type === 'delete') {
        setItems((prev) => prev.filter((d) => d.id !== event.id));
        return;
      }
      upsert(event.drop);
      if (!panelOpenRef.current) setUnseen((n) => n + 1);
      pushToast({
        tone: 'incoming',
        message: `From ${event.drop.deviceLabel ?? 'another device'}`,
        drop: event.drop,
      });
    },
    [pushToast, upsert],
  );

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let pingTimer: number | null = null;
    let stopped = false; // auth failure: don't hammer the server

    const clearTimers = () => {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pingTimer !== null) window.clearInterval(pingTimer);
      reconnectTimer = pingTimer = null;
    };

    const scheduleReconnect = () => {
      if (disposed || stopped || reconnectTimer !== null) return;
      if (document.visibilityState === 'hidden') return; // Reconnects on return.
      const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
      attempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposed || stopped) return;
      if (socket && socket.readyState <= WebSocket.OPEN) return;
      setLive('connecting');
      let auth;
      try {
        auth = await liveTicket();
      } catch (err) {
        setLive('offline');
        if (err instanceof Error && /unauthenticated|sign in/.test(err.message)) stopped = true;
        scheduleReconnect();
        return;
      }
      if (disposed) return;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/api/drops/live?u=${encodeURIComponent(auth.userId)}&ticket=${encodeURIComponent(auth.ticket)}`;
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        attempt = 0;
        setLive('live');
        void refresh(); // Catch anything sent while we were disconnected.
        pingTimer = window.setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, PING_MS);
      };
      ws.onmessage = (msg) => {
        if (typeof msg.data !== 'string' || msg.data === 'pong') return;
        try {
          onEvent(JSON.parse(msg.data) as HubEvent);
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = () => {
        if (socket === ws) socket = null;
        if (pingTimer !== null) window.clearInterval(pingTimer);
        pingTimer = null;
        if (disposed) return;
        setLive('offline');
        scheduleReconnect();
      };
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
      if (!socket) {
        attempt = 0;
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
        void connect();
      }
    };
    const onOnline = () => onVisible();

    void refresh();
    void connect();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      disposed = true;
      clearTimers();
      socket?.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [onEvent, refresh]);

  // ---- global paste & drag-and-drop ---------------------------------------

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target) || isEditable(document.activeElement) || modalOpen()) return;
      const data = event.clipboardData;
      if (!data) return;
      const files = Array.from(data.files).map(renamePasted);
      if (files.length) {
        event.preventDefault();
        sendFiles(files);
        return;
      }
      const text = data.getData('text/plain');
      if (text.trim()) {
        event.preventDefault();
        sendText(text);
      }
    };

    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e) || modalOpen()) return;
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e) || modalOpen()) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      if (!hasFiles(e) || modalOpen()) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) sendFiles(files);
    };

    document.addEventListener('paste', onPaste);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [sendFiles, sendText]);

  const value = useMemo<DropsContextValue>(
    () => ({ items, unseen, live, panelOpen, setPanelOpen, sendText, sendFiles, remove, retry }),
    [items, unseen, live, panelOpen, setPanelOpen, sendText, sendFiles, remove, retry],
  );

  return (
    <DropsContext.Provider value={value}>
      {children}
      {dragging ? (
        <div className="pointer-events-none fixed inset-0 z-[90] flex items-center justify-center bg-ev-paper/70 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 rounded-[var(--ev-r-panel)] border-2 border-dashed border-ev-slate bg-ev-paper px-10 py-8 text-center shadow-[var(--ev-e-3)]">
            <Upload className="h-7 w-7 text-action" />
            <p className="text-sm font-semibold text-ev-ink">Drop to send to your devices</p>
            <p className="text-xs text-ev-ink-2">It shows up on your other computers right away.</p>
          </div>
        </div>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismissToast} onUndo={(t) => t.drop && remove(t.drop.id)} />
    </DropsContext.Provider>
  );
}

function ToastStack({
  toasts,
  onDismiss,
  onUndo,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onUndo: (toast: Toast) => void;
}) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 right-4 z-[95] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'pointer-events-auto rounded-[var(--ev-r-pop)] border bg-ev-paper p-3 shadow-[var(--ev-e-3)]',
            toast.tone === 'error' ? 'border-ev-warn-ink' : 'border-ev-line',
          )}
        >
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className={cn('text-xs font-semibold', toast.tone === 'error' ? 'text-ev-warn-ink' : 'text-ev-ink')}>
                {toast.message}
              </p>
              {toast.tone === 'incoming' && toast.drop ? (
                <p className="mt-1 line-clamp-2 break-words text-xs text-ev-ink-2">
                  {toast.drop.kind === 'text' ? toast.drop.preview : toast.drop.filename}
                </p>
              ) : null}
            </div>
            {toast.tone === 'sent' ? (
              <button
                type="button"
                onClick={() => {
                  onUndo(toast);
                  onDismiss(toast.id);
                }}
                className="rounded-[var(--ev-r-ctl)] px-2 py-1 text-xs font-medium text-action hover:bg-[var(--ev-hover)]"
              >
                Undo
              </button>
            ) : null}
            {toast.tone === 'incoming' && toast.drop ? <ToastAction drop={toast.drop} /> : null}
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              aria-label="Dismiss"
              className="rounded-[var(--ev-r-ctl)] p-1 text-ev-ink-2 hover:bg-[var(--ev-hover)] hover:text-ev-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ToastAction({ drop }: { drop: Drop }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  if (drop.kind === 'file') {
    return (
      <a
        href={downloadUrl(drop)}
        download={drop.filename ?? true}
        className="flex items-center gap-1 rounded-full bg-action font-round font-bold px-2 py-1 text-xs text-ev-on-slate hover:bg-action-hover"
      >
        <Download className="h-3.5 w-3.5" /> Download
      </a>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        copyDropText(drop)
          .then(() => setCopyState('copied'))
          .catch(() => setCopyState('failed'))
          .finally(() => window.setTimeout(() => setCopyState('idle'), 2000));
      }}
      className="flex items-center gap-1 rounded-full bg-action font-round font-bold px-2 py-1 text-xs text-ev-on-slate hover:bg-action-hover"
    >
      {copyState === 'copied' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

function blankDrop(id: string): Drop {
  return {
    id,
    kind: 'text',
    text: null,
    preview: null,
    filename: null,
    contentType: null,
    bytes: 0,
    deviceLabel: 'This device',
    createdAt: Date.now(),
    contentUrl: '',
  };
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/** Clipboard screenshots arrive as "image.png"; give them a findable name. */
function renamePasted(file: File): File {
  if (file.name && file.name !== 'image.png') return file;
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  const ext = file.type.split('/')[1] ?? 'bin';
  return new File([file], `Pasted ${stamp}.${ext}`, { type: file.type });
}
