import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Upload } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { AppAlert, AppPage, AppPageHeader, appButton } from '@/components/ui/app-page';
import { importFile } from '@/lib/imports/upload';

export const Route = createFileRoute('/app/import')({ component: Imports });

const jobsSchema = z.object({
  imports: z.array(
    z.object({ meetingId: z.string(), title: z.string(), status: z.string(), state: z.string(), error: z.string().nullable() }),
  ),
});
type Job = z.infer<typeof jobsSchema>['imports'][number];

const POLL_MS = 5000;

/** Nothing more will happen to it without the user acting. */
function isSettled(job: Job): boolean {
  return job.state === 'cancelled' || job.status === 'complete' || job.status === 'failed';
}

function statusLabel(job: Job): string {
  if (job.state === 'cancelled') return 'Cancelled';
  if (job.status === 'complete') return 'Done';
  if (job.status === 'failed') return 'Didn’t finish';
  if (job.status === 'uploading') return 'Uploading';
  return 'Transcribing in the cloud…';
}

function Imports() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/imports/');
      if (!r.ok) throw new Error('Could not load imports');
      setJobs(jobsSchema.parse(await r.json()).imports);
    } catch {
      setError('Could not load imports. Refresh to retry.');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controller.current?.abort();
  }, [load]);

  // Poll only while the cloud is still working on an import, or this page is
  // uploading one. An interrupted upload waits for the user, so it doesn't count.
  const active = busy || (jobs?.some((job) => !isSettled(job) && job.status !== 'uploading') ?? false);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError('');
    const abort = new AbortController();
    controller.current = abort;
    try {
      for (const file of Array.from(files)) {
        abort.signal.throwIfAborted();
        try {
          await importFile(file, abort.signal, (text) => setMessage(`${file.name}: ${text}`));
        } catch (e) {
          if (abort.signal.aborted) throw e;
          setError(`${file.name}: ${e instanceof Error ? e.message : 'Import failed'}`);
        }
        await load();
      }
    } catch {
      setMessage('Upload paused. Select the same files to resume.');
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }

  async function action(id: string, method: 'DELETE' | 'POST') {
    const response = await fetch(`/api/imports/${id}${method === 'POST' ? '/retry' : ''}`, { method });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      setError(z.object({ error: z.string().optional() }).safeParse(body).data?.error ?? 'Operation failed');
    }
    await load();
  }

  return (
    <AppPage width="reading">
      <AppPageHeader
        title="Import recordings"
        description="Choose audio files up to 60 minutes and 100 MiB each. Keep this page open while they upload; transcription then continues in the cloud. To resume an interrupted upload, select the same file again."
        action={
          busy ? (
            <button type="button" className={appButton('secondary')} onClick={() => controller.current?.abort()}>
              <Pause className="h-4 w-4" /> Pause uploads
            </button>
          ) : (
            <label className={appButton('primary')}>
              <Upload className="h-4 w-4" /> Choose files
              <input
                aria-label="Audio files"
                type="file"
                multiple
                accept=".m4a,.mp4,.mp3,.wav,.webm,.ogg,.opus"
                className="sr-only"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          )
        }
      />

      {message ? <AppAlert tone="info">{message}</AppAlert> : null}
      {error ? <AppAlert>{error}</AppAlert> : null}

      {jobs?.length ? (
        <ul className="flex flex-col divide-y divide-ev-line">
          {jobs.map((job) => (
            <li key={job.meetingId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <Link href={`/app/meetings/${job.meetingId}`} className="block truncate font-round text-[14.5px] font-bold text-ev-ink hover:text-ev-coat">
                  {job.title}
                </Link>
                <p className="text-[13px] text-ev-ink-2">{statusLabel(job)}</p>
                {job.error ? <p className="text-[13px] text-ev-warn-ink">{job.error}</p> : null}
              </div>
              <div className="flex shrink-0 gap-1.5">
                {(job.status === 'failed' || !!job.error) && job.state !== 'cancelled' ? (
                  <button type="button" className={appButton('secondary', 'sm')} onClick={() => void action(job.meetingId, 'POST')}>
                    Retry processing
                  </button>
                ) : null}
                {!isSettled(job) ? (
                  <button type="button" className={appButton('ghost', 'sm')} onClick={() => void action(job.meetingId, 'DELETE')}>
                    Cancel
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <Link href="/app/memory" className="text-sm font-semibold text-ev-coat hover:text-ev-coat-hover">Ask your library →</Link>
    </AppPage>
  );
}
