'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg, hotkeyConflict, isDesktop, openKeyboardSettings, setHotkey, suspendHotkeys } from '@/lib/desktop/bridge';
import * as Dialog from '@radix-ui/react-dialog';

export function HotkeyRecorder({
  action,
  initial,
  label,
  onSaved,
}: {
  action: 'toggle' | 'dictation';
  initial: string;
  label: string;
  onSaved?: () => void;
}) {
  const desktop = isDesktop();
  const [accel, setAccel] = useState(initial);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ accelerator: string; title: string; detail: string } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const save = useCallback(async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      await setHotkey(action, next);
      setAccel(next);
      setPending(null);
      onSaved?.();
    } catch (err) {
      setPending(null);
      setError(errMsg(err, 'Could not set hotkey'));
    } finally { setBusy(false); }
  }, [action, onSaved]);

  const propose = useCallback(async (next: string) => {
    setRecording(false);
    setError(null);
    setBusy(true);
    try {
      const conflict = await hotkeyConflict(next);
      if (conflict) setPending({ accelerator: next, ...conflict });
      else await save(next);
    } catch (err) {
      setError(errMsg(err, 'Could not check shortcut'));
    } finally { setBusy(false); }
  }, [save]);

  const onKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (!recording) return;
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }

      const mods: string[] = [];
      if (e.metaKey) mods.push('Cmd');
      if (e.ctrlKey) mods.push('Ctrl');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');

      const main = mainKeyFromCode(e.code, e.key);
      if (!main) return;
      if (!e.metaKey && !e.ctrlKey) {
        setError('Include ⌘ or ⌃ in the shortcut.');
        return;
      }

      await propose([...mods, main].join('+'));
    },
    [recording, propose],
  );

  useEffect(() => {
    if (recording) btnRef.current?.focus();
  }, [recording]);

  useEffect(() => {
    if (!recording || !desktop) return;
    void suspendHotkeys(true).catch(() => {});
    return () => {
      void suspendHotkeys(false).catch(() => {});
    };
  }, [recording, desktop]);

  return (
    <div className="flex flex-col gap-1">
      <button
        ref={btnRef}
        type="button"
        disabled={!desktop || busy}
        onClick={() => desktop && setRecording((r) => !r)}
        onKeyDown={(event) => {
          void onKeyDown(event);
        }}
        onBlur={() => setRecording(false)}
        className={[
          'flex h-9 min-w-44 items-center justify-between gap-3 rounded-md border px-3 text-sm transition-colors',
          recording
            ? 'border-accent ring-2 ring-accent/30'
            : 'border-border hover:bg-muted',
          !desktop ? 'cursor-not-allowed opacity-60' : '',
        ].join(' ')}
      >
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-[13px] text-foreground">
          {busy ? 'Checking…' : recording ? 'Press keys…' : glyphs(accel)}
        </span>
      </button>
      {desktop && (
        <button type="button" disabled={busy} onClick={() => { void propose('Fn'); }} className="self-end rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50">
          Use Fn / Globe tap
        </button>
      )}
      <Dialog.Root open={pending !== null} onOpenChange={(open) => { if (!open && !busy) setPending(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content onKeyDown={(event) => event.stopPropagation()} className="fixed left-1/2 top-1/2 z-50 w-[min(460px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-background p-5 text-foreground shadow-xl">
            <Dialog.Title className="text-sm font-semibold">{pending?.title}</Dialog.Title>
            <Dialog.Description className="mt-2 text-xs leading-relaxed text-muted-foreground">{pending?.detail}</Dialog.Description>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => { void openKeyboardSettings().catch(() => setError('Open System Settings → Keyboard manually.')); }} className="rounded-md border border-border px-3 py-2 text-xs">Open Keyboard settings</button>
              <Dialog.Close disabled={busy} className="rounded-md px-3 py-2 text-xs">Cancel</Dialog.Close>
              <button type="button" disabled={busy} onClick={() => { if (pending) void save(pending.accelerator); }} className="rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50">{busy ? 'Saving…' : 'Use this shortcut'}</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {!desktop && (
        <span className="text-[11px] text-muted-foreground">
          Set your hotkey in the Mac app.
        </span>
      )}
      {error && <span role="alert" className="text-[11px] text-red-500">{error}</span>}
      {error?.includes('Input Monitoring') && <button type="button" onClick={() => { void openKeyboardSettings(true).catch(() => setError('Open System Settings → Privacy & Security → Input Monitoring manually.')); }} className="self-start rounded border border-border px-2 py-1 text-xs">Open Input Monitoring</button>}
    </div>
  );
}

function mainKeyFromCode(code: string, key: string): string | null {
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit(\d)$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Enter',
    Backslash: '\\',
    Slash: '/',
    Period: '.',
    Comma: ',',
    Semicolon: ';',
    Quote: "'",
    BracketLeft: '[',
    BracketRight: ']',
    Minus: '-',
    Equal: '=',
    Backquote: '`',
  };
  if (named[code]) return named[code];
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key)) return null;
  return null;
}

function glyphs(accel: string): string {
  return accel
    .split('+')
    .map((p) => {
      const k = p.trim().toLowerCase();
      if (['cmd', 'command', 'super', 'meta'].includes(k)) return '⌘';
      if (k === 'shift') return '⇧';
      if (['alt', 'option'].includes(k)) return '⌥';
      if (['ctrl', 'control'].includes(k)) return '⌃';
      return p.trim();
    })
    .join(' ');
}
