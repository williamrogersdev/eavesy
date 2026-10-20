import { Check, Copy, Plus, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useChipField } from '@/components/ui/use-chip-field';
import { copyText } from '@/lib/desktop/bridge';
import { MAX_TERM_LENGTH } from '@/lib/transcription/vocabulary';
import { cn } from '@/lib/utils';

/**
 * Words as chips: Enter, comma or Tab adds what is typed, Backspace on an
 * empty box takes the last one off, and a pasted list becomes one chip each.
 * A long list scrolls, newest first, and the box also searches it.
 */
export function TagInput({ value, onChange, placeholder, max = Infinity, label, disabled, className }: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  const field = useChipField({ value, onChange, max, maxLength: MAX_TERM_LENGTH });
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const chips = field.shown.map((tag) => (
    <span key={tag.toLowerCase()} className="ev-tag">
      <span className="truncate">{tag}</span>
      <button
        type="button"
        aria-label={`Remove ${tag}`}
        disabled={disabled}
        onClick={(e) => { e.stopPropagation(); field.remove(tag); input.current?.focus(); }}
      >
        <X size={11} strokeWidth={2.25} aria-hidden />
      </button>
    </span>
  ));

  const box = (
    <input
      ref={input}
      aria-label={label}
      value={field.draft}
      disabled={disabled || (field.full && !field.long)}
      maxLength={MAX_TERM_LENGTH}
      autoComplete="off"
      spellCheck={false}
      placeholder={
        field.long
          ? field.full ? `Search ${value.length} words` : `Add a word, or search ${value.length}`
          : field.full ? `Up to ${max}` : value.length ? '' : placeholder
      }
      onChange={(e) => field.onInputChange(e.target.value)}
      onKeyDown={field.onKeyDown}
      onPaste={field.onPaste}
      onBlur={field.onBlur}
    />
  );

  if (!field.long) {
    return (
      <div className={cn('ev-tags', className)} data-disabled={disabled || undefined} onClick={() => input.current?.focus()}>
        {chips}
        {box}
      </div>
    );
  }

  return (
    <div className={cn('ev-tags-long', className)} data-disabled={disabled || undefined}>
      <div className="ev-tags-find">
        {field.full ? <Search size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
        {box}
        {field.draft && (
          <span className="ev-tags-note">
            {field.duplicate ? 'Already added' : field.full ? `${field.shown.length} found` : `${field.shown.length} found · Enter adds it`}
          </span>
        )}
      </div>
      <div className="ev-tags-list">
        {field.shown.length ? chips : <span className="ev-tags-note">No word matches “{field.draft.trim()}”.</span>}
      </div>
      <div className="ev-tags-foot">
        <span>{Number.isFinite(max) ? `${value.length} of ${max}` : `${value.length} words`}</span>
        <span className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => {
              void copyText(value.join('\n')).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? <Check size={11} aria-hidden /> : <Copy size={11} aria-hidden />}
            {copied ? 'Copied' : 'Copy all'}
          </button>
          {confirmClear ? (
            <>
              <button type="button" className="ev-tags-danger" onClick={() => { field.clear(); setConfirmClear(false); }}>
                Remove all {value.length}
              </button>
              <button type="button" onClick={() => setConfirmClear(false)}>Keep</button>
            </>
          ) : (
            <button type="button" disabled={disabled} onClick={() => setConfirmClear(true)}>Clear</button>
          )}
        </span>
      </div>
    </div>
  );
}
