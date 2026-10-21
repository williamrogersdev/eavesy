import { Button, IconButton, Mascot } from '@/components/launcher/ui';
import './translator.css';
import { ArrowLeft, ArrowLeftRight, Check, ClipboardPaste, Copy, Languages, Mic, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrowserAudioCapture } from '@/lib/audio/browser-recorder';
import { copyText, isDesktop, pasteToFrontmost } from '@/lib/desktop/bridge';
import { LANGUAGES, isLanguage, languageName, MAX_TRANSLATION_TEXT, type Language, type SourceLanguage, type TranslationResult } from '@/lib/translation/languages';
import { readClipboardText, requestTranslation, voicePayload, TranslationError } from '@/lib/translation/client';


export function Translator({ onBack, initialText = '' }: { onBack?: () => void; initialText?: string }) {
  const [source, setSource] = useState<SourceLanguage>('auto');
  const [target, setTarget] = useState<Language>('en');
  const [text, setText] = useState(initialText);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [show, setShow] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const capture = useRef<BrowserAudioCapture | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const locked = busy || listening || starting;

  useEffect(() => {
    mounted.current = true;
    const requests = generation;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('eavesy.translation.languages') || 'null');
      const saved = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
      if (saved && (saved.source === 'auto' || isLanguage(saved.source)) && isLanguage(saved.target)) {
        setSource(saved.source); setTarget(saved.target);
      }
    } catch { /* Storage may be disabled. */ }
    return () => {
      mounted.current = false;
      requests.current++;
      capture.current?.dispose();
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function languages(nextSource: SourceLanguage, nextTarget: Language) {
    setSource(nextSource); setTarget(nextTarget); setResult(null); setError(''); setNotice('');
    generation.current++;
    try { localStorage.setItem('eavesy.translation.languages', JSON.stringify({ source: nextSource, target: nextTarget })); } catch { /* Optional. */ }
  }
  function edit(value: string) {
    setText(value); setResult(null); setError(''); setNotice(''); generation.current++;
  }
  async function translate(audio?: string) {
    const id = ++generation.current;
    setBusy(true); setError(''); setNotice(''); setResult(null);
    try {
      const output = await requestTranslation({ ...(audio ? { audio } : { text }), source, target });
      if (!mounted.current || id !== generation.current) return;
      setText(output.text); setResult(output);
    } catch (err) {
      if (mounted.current && id === generation.current) {
        if (err instanceof TranslationError && err.sourceText) setText(err.sourceText);
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally { if (mounted.current && id === generation.current) setBusy(false); }
  }
  async function stop(cancel = false) {
    const cap = capture.current;
    if (!cap) return;
    capture.current = null;
    if (timer.current) clearTimeout(timer.current);
    setListening(false); setBusy(!cancel);
    try {
      const blob = await cap.stop();
      cap.dispose();
      if (!cancel && mounted.current) await translate(await voicePayload(blob));
    } catch (err) {
      cap.dispose();
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not transcribe. Try again.');
    } finally { if (mounted.current) setBusy(false); }
  }
  async function speak() {
    setError(''); setNotice(''); setStarting(true); setResult(null);
    const cap = new BrowserAudioCapture();
    capture.current = cap;
    try {
      await cap.requestPermissions();
      if (!mounted.current) { cap.dispose(); return; }
      cap.startPreflight();
      await cap.start();
      if (!mounted.current) { cap.dispose(); return; }
      setListening(true);
      timer.current = setTimeout(() => void stop(), 59_000);
    } catch {
      cap.dispose(); capture.current = null;
      if (mounted.current) setError('Microphone unavailable. Allow microphone access, or paste text below.');
    } finally { if (mounted.current) setStarting(false); }
  }
  async function clipboard() {
    try { edit(await readClipboardText()); }
    catch { setError('Clipboard access unavailable. Paste into the text box with ⌘V or Ctrl+V.'); }
  }
  async function deliver(paste = false) {
    if (!result) return;
    try {
      if (paste) await pasteToFrontmost(result.translation, false);
      else await copyText(result.translation);
      setNotice(paste ? 'Pasted' : 'Copied'); setError('');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not copy. Select the translation to copy it manually.'); }
  }
  function swap() {
    if (source === 'auto') return;
    if (result) setText(result.translation);
    languages(target, source);
  }
  const tooLong = text.length > MAX_TRANSLATION_TEXT;

  return (
    <section className="ev-translator" aria-label="Quick translation" onKeyDown={e => {
      e.stopPropagation();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !locked && text.trim() && !tooLong) { e.preventDefault(); void translate(); }
      if (e.key === 'Escape') {
        if (show) setShow(false);
        else if (listening) void stop(true);
        else if (!locked) onBack?.();
      }
    }}>
      <header className="ev-translate-head">
        {onBack && <IconButton label="Back to captures" icon={ArrowLeft} onClick={onBack} disabled={locked} />}
        <div><h2>Translate</h2><p>Speak, type, or paste. Share in another language.</p></div>
      </header>
      <div className="ev-translate-body">
        <div className="ev-translate-languages">
          <label className="ev-field">From
            <select aria-label="Source language" disabled={locked} value={source} onChange={e => languages(e.target.value as SourceLanguage, target)} className="ev-field-input">
              <option value="auto">Detect language</option>
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          <IconButton label="Swap languages" icon={ArrowLeftRight} title={source === 'auto' ? 'Choose a source language to swap' : 'Swap languages'} disabled={locked || source === 'auto'} onClick={swap} />
          <label className="ev-field">To
            <select aria-label="Translation language" disabled={locked} value={target} onChange={e => languages(source, e.target.value as Language)} className="ev-field-input">
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          </label>
          <Button size="sm" variant="quiet" disabled={locked || target === 'en'} onClick={() => languages(source, 'en')}>To English</Button>
        </div>
        <div className="ev-translate-source">
          <textarea aria-label="Text to translate" dir="auto" placeholder="Type or paste, or tap Speak" value={text} disabled={locked} onChange={e => edit(e.target.value)} className="ev-field-input" />
          {text && !locked && <IconButton label="Clear text" icon={X} onClick={() => edit('')} />}
          {tooLong && <p role="alert" className="ev-translate-error">Use up to 4,000 characters ({text.length.toLocaleString()} entered).</p>}
        </div>
        <div className="ev-translate-actions">
          {listening ? <>
            <Button size="sm" variant="danger-rec" icon={Square} onClick={() => void stop()}>Stop & translate</Button>
            <Button size="sm" onClick={() => void stop(true)}>Cancel</Button>
            <span role="status" className="ev-translate-status"><Mascot size={16} state="listening" recording />Listening · up to 60s</span>
          </> : <>
            <Button size="sm" icon={Mic} loading={starting} disabled={locked} onClick={() => void speak()}>Speak</Button>
            <Button size="sm" icon={ClipboardPaste} disabled={locked} onClick={() => void clipboard()}>Paste text</Button>
            <Button size="sm" variant="primary" icon={Languages} loading={busy} disabled={locked || !text.trim() || tooLong} onClick={() => void translate()}>{busy ? 'Translating…' : 'Translate'}</Button>
          </>}
        </div>
        {error && <p role="alert" className="ev-translate-error">{error}</p>}
        {result ? <div className="ev-translate-result">
          <div className="ev-translate-actions">
            <span>{languageName(result.target)}</span>
            <Button size="sm" onClick={() => setShow(true)}>Show</Button>
            <Button size="sm" icon={Copy} onClick={() => void deliver()}>Copy</Button>
            {isDesktop() && <Button size="sm" icon={ClipboardPaste} onClick={() => void deliver(true)}>Paste at cursor</Button>}
          </div>
          <p aria-label="Translation" dir="auto" lang={result.target}>{result.translation}</p>
        </div> : <p className="ev-translate-hint">Your original stays here. Only the translation is copied or pasted.</p>}
        {notice && <p role="status" className="ev-translate-status"><Check size={14} />{notice}</p>}
      </div>
      {show && result && <ShowTranslation result={result} onClose={() => setShow(false)} />}
    </section>
  );
}

function ShowTranslation({ result, onClose }: { result: TranslationResult; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} onCancel={e => { e.preventDefault(); onClose(); }} aria-label="Show translation" className="ev ev-translate-show">
    <div><header><span>{languageName(result.target)}</span><Button size="sm" icon={X} onClick={onClose} aria-label="Close translation">Done</Button></header>
      <p dir="auto" lang={result.target}>{result.translation}</p>
    </div>
  </dialog>;
}
