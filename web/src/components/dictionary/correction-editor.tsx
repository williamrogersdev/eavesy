import { Button } from '@/components/launcher/ui';
import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useRef, useState } from 'react';
import { correctTranscript } from '@/lib/desktop/bridge';

export function CorrectionEditor({ id, original, loadOriginal, onSaved, open, onOpenChange, onCloseFocus }: {
  id: string;
  original: string;
  loadOriginal?: () => Promise<string>;
  onSaved: (text: string) => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseFocus?: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const editing = open ?? localOpen;
  const [text, setText] = useState(original);
  const [baseline, setBaseline] = useState(original);
  const [savedText, setSavedText] = useState(original);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryLearning, setRetryLearning] = useState(false);
  const [discard, setDiscard] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const source = useRef(original);
  source.current = original;
  const loader = useRef(loadOriginal);
  loader.current = loadOriginal;
  const dirty = text !== savedText;
  const close = () => { setLocalOpen(false); onOpenChange?.(false); };
  const changeOpen = (value: boolean) => {
    if (busy) return;
    if (!value && dirty) { setDiscard(true); return; }
    setLocalOpen(value);
    onOpenChange?.(value);
  };

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    setLoading(true); setNotice(''); setDiscard(false); setLoadFailed(false); setRetryLearning(false);
    void (async () => {
      try {
        const full = loader.current ? await loader.current() : source.current;
        if (!cancelled) { setBaseline(full); setSavedText(full); setText(full); }
      } catch (error) {
        if (!cancelled) { setLoadFailed(true); setNotice(error instanceof Error ? error.message : 'Could not open transcript'); }
      } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [editing, id]);

  useEffect(() => {
    if (editing && !loading) field.current?.focus();
  }, [editing, loading]);

  const save = async () => {
    if (busy || loading || loadFailed || !text.trim() || (!dirty && !retryLearning)) return;
    setBusy(true); setNotice('');
    try {
      const { warning } = await correctTranscript(id, baseline, text);
      // A learning failure must not lose a successfully saved correction.
      setSavedText(text);
      setRetryLearning(!!warning);
      if (warning) {
        setNotice(`Transcript saved. ${warning}`);
      } else {
        setBaseline(text);
        setLocalOpen(false); onOpenChange?.(false);
      }
      onSaved(text);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save correction'); }
    finally { setBusy(false); }
  };

  return <Dialog.Root open={editing} onOpenChange={changeOpen}>
    {open === undefined && <Dialog.Trigger asChild><Button size="sm">Edit transcript</Button></Dialog.Trigger>}
    <Dialog.Portal>
      <Dialog.Overlay className="ev ev-correction-overlay" />
      <Dialog.Content className="ev ev-correction" onCloseAutoFocus={e => { if (onCloseFocus) { e.preventDefault(); onCloseFocus(); } }} onEscapeKeyDown={e => { e.preventDefault(); changeOpen(false); }} onPointerDownOutside={e => e.preventDefault()} onKeyDown={e => {
        e.stopPropagation();
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
      }}>
        <header className="ev-correction-head">
          <Dialog.Title>Edit transcript</Dialog.Title>
          <Dialog.Description>Fix a word or rewrite a passage. Your audio stays the same.</Dialog.Description>
        </header>
        {loading ? <p className="ev-correction-loading" role="status">Opening transcript…</p> : <textarea
          ref={field}
          aria-label="Transcript"
          className="ev-correction-text"
          value={text}
          onChange={e => { setText(e.target.value); setDiscard(false); }}
          readOnly={busy || loadFailed}
          spellCheck
        />}
        {notice && <p role="status" className="ev-correction-notice">{notice}</p>}
        <footer className="ev-correction-foot">
          {discard ? <>
            <span>Discard your changes?</span>
            <Button size="sm" onClick={() => { setDiscard(false); field.current?.focus(); }}>Keep editing</Button>
            <Button size="sm" variant="primary" onClick={close}>Discard</Button>
          </> : <>
            <Button size="sm" disabled={busy} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" kbd="⌘↵" loading={busy} disabled={loading || loadFailed || !text.trim() || (!dirty && !retryLearning)} onClick={() => void save()}>{retryLearning ? 'Retry learning' : 'Save changes'}</Button>
          </>}
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
