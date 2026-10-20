import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useEffect, useRef, useState } from 'react';
import { Link } from '@/components/ui/app-link';
import { importFile } from '@/lib/imports/upload';
export const Route = createFileRoute('/app/import')({ component: Imports });
const jobsSchema = z.object({ imports: z.array(z.object({ meetingId: z.string(), title: z.string(), status: z.string(), state: z.string(), error: z.string().nullable() })) });
type Job = z.infer<typeof jobsSchema>['imports'][number];
function Imports() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  async function load() {
    try { const r = await fetch('/api/imports/'); if (!r.ok) throw new Error('Could not load imports'); setJobs(jobsSchema.parse(await r.json()).imports); }
    catch { setError('Could not load imports. Refresh to retry.'); }
  }
  useEffect(() => { void load(); const t = setInterval(() => void load(), 5000); return () => { clearInterval(t); controller.current?.abort(); }; }, []);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true); setError('');
    const abort = new AbortController(); controller.current = abort;
    try {
      for (const file of Array.from(files)) {
        abort.signal.throwIfAborted();
        try { await importFile(file, abort.signal, text => setMessage(`${file.name}: ${text}`)); }
        catch (e) { if (abort.signal.aborted) throw e; setError(`${file.name}: ${e instanceof Error ? e.message : 'Import failed'}`); }
        await load();
      }
    } catch { setMessage('Upload paused. Select the same files to resume.'); }
    finally { setBusy(false); controller.current = null; }
  }
  async function action(id: string, method: 'DELETE' | 'POST') {
    const response = await fetch(`/api/imports/${id}${method === 'POST' ? '/retry' : ''}`, { method });
    if (!response.ok) setError(z.object({ error: z.string().optional() }).parse(await response.json()).error ?? 'Operation failed');
    await load();
  }
  return <div className="mx-auto max-w-3xl space-y-6 p-8">
    <h1 className="text-2xl font-semibold">Import recordings</h1>
    <p className="text-sm text-muted-foreground">Choose audio files up to 60 minutes and 100 MiB each. Keep this page open during upload. Once uploaded, transcription continues in the cloud. To resume an interrupted upload, select the same file again.</p>
    <input aria-label="Audio files" type="file" multiple accept=".m4a,.mp4,.mp3,.wav,.webm,.ogg,.opus" disabled={busy} onChange={e => { void upload(e.target.files); e.target.value = ''; }} />
    {busy && <button className="rounded border px-3 py-2" onClick={() => controller.current?.abort()}>Pause uploads</button>}
    <p role="status" className="text-sm">{message}</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <ul className="space-y-3">{jobs.map(job => <li key={job.meetingId} className="space-y-2 rounded-lg border p-4">
      <Link href={`/app/meetings/${job.meetingId}`} className="font-medium text-accent">{job.title}</Link>
      <p className="text-sm">{job.state === 'cancelled' ? 'Cancelled' : job.status}</p>
      {job.error && <p className="text-sm text-danger">{job.error}</p>}
      {(job.status === 'failed' || !!job.error) && job.state !== 'cancelled' && <button className="rounded border px-3 py-1" onClick={() => void action(job.meetingId, 'POST')}>Retry processing</button>}
      {!['complete', 'failed'].includes(job.status) && <button className="rounded border px-3 py-1" onClick={() => void action(job.meetingId, 'DELETE')}>Cancel processing</button>}
    </li>)}</ul>
    <Link href="/app/memory" className="text-accent">Ask your library →</Link>
  </div>;
}
