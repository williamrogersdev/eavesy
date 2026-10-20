import { Button } from '@/components/launcher/ui';
import { useState } from 'react';
import { correctTranscript } from '@/lib/desktop/bridge';

export function CorrectionEditor({ id, original, onSaved }: { id: string; original: string; onSaved: (text: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(original);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const save = async () => {
    setBusy(true); setNotice('');
    try {
      const { learned } = await correctTranscript(id, original, text);
      onSaved(text); setEditing(false);
      setNotice(learned ? `Saved. Learned ${learned} correction${learned === 1 ? '' : 's'} for future recordings.` : 'Transcript saved. No vocabulary changes to learn.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not save correction'); }
    finally { setBusy(false); }
  };
  return <div className="mt-3 text-sm">
    {editing ? <>
      <textarea aria-label="Correct transcript" className="ev-field-input min-h-32 w-full" value={text} onChange={e => setText(e.target.value)} disabled={busy} />
      <div className="flex gap-3 py-2">
        <Button size="sm" type="button" disabled={busy || !text.trim() || text === original} onClick={() => void save()}>{busy ? 'Saving…' : 'Save corrections'}</Button>
        <Button size="sm" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
      </div>
    </> : <Button size="sm" type="button" onClick={() => { setText(original); setEditing(true); setNotice(''); }} className="ev-link">Edit transcript</Button>}
    {notice && <p role="status" className="mt-2 text-xs text-[var(--ev-ink-2)]">{notice}</p>}
  </div>;
}
