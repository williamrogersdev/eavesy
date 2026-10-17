import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Paperclip, Plus, X } from 'lucide-react';
import { Button } from './button';
import { IconButton } from './icon-button';
import { Kbd } from './kbd';
import { Mascot } from './mascot';

export type ComposerHandle = {
  focus: () => void;
  /** Routes pasted or dropped text into the draft (long text collapses). */
  insertText: (text: string) => void;
  /** One-shot "Saved" confirmation after something lands via drop or paste. */
  confirm: () => void;
};

export type ComposerProps = {
  onSaveNote: (text: string) => void | Promise<void>;
  /** A save failed. The draft is kept so nothing typed is lost. */
  onSaveError?: (error: unknown) => void;
  /** Files pasted into the field (or picked, when there is no `onPick`). Native drag-drop paths are handled by the panel. */
  onFiles: (files: File[]) => void;
  /** Opens a native file picker instead of the browser one (the desktop app needs real paths). */
  onPick?: () => void;
  placeholder?: string;
  maxLines?: number;
  /** Set by a panel-level drag listener while a file hovers the panel. */
  dragActive?: boolean;
  /** Called when Esc is pressed on an empty composer (the panel decides what that means). */
  onEscapeEmpty?: () => void;
};

const LINE = 20;
/** Pasted text longer than this is shown as a collapsed block instead of raw lines. */
const COLLAPSE_CHARS = 280;
const COLLAPSE_LINES = 6;

export function shouldCollapse(text: string): boolean {
  return text.length > COLLAPSE_CHARS || text.split('\n').length > COLLAPSE_LINES;
}

export function noteText(draft: string, pasted: string | null): string {
  return [draft.trim(), pasted?.trim() ?? ''].filter(Boolean).join('\n\n');
}

/**
 * The one obvious place to put things in (DESIGN.md §5): typed notes, paste,
 * file picker and drop target. Pinned to the bottom; grows upward over the
 * list and never reflows it.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { onSaveNote, onSaveError, onFiles, onPick, placeholder = 'Paste, drop a file, or jot a note…', maxLines = 4, dragActive = false, onEscapeEmpty },
  ref,
) {
  const [draft, setDraft] = useState('');
  const [pasted, setPasted] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [hoverAdd, setHoverAdd] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const savedTimer = useRef<number | undefined>(undefined);

  const confirm = useCallback(() => {
    setSaved(true);
    window.clearTimeout(savedTimer.current);
    savedTimer.current = window.setTimeout(() => setSaved(false), 1400);
  }, []);
  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  const insertText = useCallback((text: string) => {
    if (shouldCollapse(text)) {
      setPasted((prev) => (prev ? `${prev}\n\n${text}` : text));
    } else {
      const el = fieldRef.current;
      if (el && document.activeElement === el) {
        const { selectionStart: a, selectionEnd: b } = el;
        setDraft((d) => d.slice(0, a) + text + d.slice(b));
      } else {
        setDraft((d) => (d ? `${d}${d.endsWith('\n') ? '' : ' '}${text}` : text));
      }
    }
    requestAnimationFrame(() => fieldRef.current?.focus({ preventScroll: true }));
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => fieldRef.current?.focus({ preventScroll: true }),
    insertText,
    confirm,
  }), [insertText, confirm]);

  // Grow upward to maxLines, then scroll inside.
  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxLines * LINE + 8)}px`;
  }, [draft, maxLines]);

  const text = noteText(draft, pasted);
  const multiline = draft.includes('\n') || pasted !== null;

  const saving = useRef(false);
  const save = useCallback(async () => {
    if (!text || saving.current) return;
    saving.current = true;
    const savedDraft = draft;
    const savedPasted = pasted;
    try {
      await onSaveNote(text);
    } catch (error) {
      onSaveError?.(error);
      return;
    } finally {
      saving.current = false;
    }
    // Keep anything typed or pasted while the save was in flight.
    setDraft((current) => current.startsWith(savedDraft) ? current.slice(savedDraft.length).trimStart() : current);
    setPasted((current) => current === savedPasted ? null : current);
    confirm();
  }, [text, draft, pasted, onSaveNote, onSaveError, confirm]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Enter' && !e.shiftKey && !multiline) {
      e.preventDefault();
      void save();
    } else if (e.key === 'Escape') {
      if (draft || pasted) {
        e.preventDefault();
        e.stopPropagation();
        setDraft('');
        setPasted(null);
      } else {
        fieldRef.current?.blur();
        onEscapeEmpty?.();
      }
    }
    // Keep panel-level shortcuts (/, N, arrows) from firing while typing.
    if (e.key !== 'Escape') e.stopPropagation();
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      onFiles(files);
      return;
    }
    const pastedText = e.clipboardData.getData('text/plain');
    if (pastedText && shouldCollapse(pastedText)) {
      e.preventDefault();
      insertText(pastedText);
    }
  };

  const lineCount = pasted ? pasted.split('\n').length : 0;

  return (
    <>
      <div className="ev-composer-fade" aria-hidden />
      <div className="ev-composer" data-drag={dragActive} data-multiline={multiline}>
        {saved ? (
          <span className="ev-ib" aria-hidden><Mascot state="happy" size={20} /></span>
        ) : (
          <IconButton
            className="ev-composer-add"
            label="Add a file"
            icon={hoverAdd ? Paperclip : Plus}
            onMouseEnter={() => setHoverAdd(true)}
            onMouseLeave={() => setHoverAdd(false)}
            onClick={() => (onPick ? onPick() : fileRef.current?.click())}
          />
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          tabIndex={-1}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length) onFiles(files);
          }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {pasted && (
            <div className="ev-composer-pasted">
              <button
                type="button"
                className="ev-composer-pasted-open"
                title="Edit the pasted text"
                onClick={() => {
                  setDraft((d) => noteText(d, pasted));
                  setPasted(null);
                  requestAnimationFrame(() => fieldRef.current?.focus());
                }}
              >
                Pasted text · {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {pasted.length.toLocaleString()} characters
              </button>
              <IconButton size={24} label="Remove pasted text" icon={X} onClick={() => setPasted(null)} />
            </div>
          )}
          <textarea
            ref={fieldRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={saved ? 'Saved' : pasted ? 'Add a line, or press ⌘↩ to save' : placeholder}
            aria-label="New note, or paste or drop a file"
            aria-multiline="true"
            className="ev-composer-field"
            spellCheck
          />
        </div>
        <div className="ev-composer-end">
          {text ? (
            <Button size="sm" variant="quiet" onClick={() => void save()} title={multiline ? 'Save (⌘↩)' : 'Save (↩)'}>
              Save
            </Button>
          ) : (
            <Kbd keys="⌘V" />
          )}
        </div>
        <div className="ev-composer-drop" aria-hidden={!dragActive}>
          <Mascot state="listening" size={28} />
          Drop to save
        </div>
      </div>
      <span className="sr-only" aria-live="polite">{dragActive ? 'Drop to save' : ''}</span>
    </>
  );
});
