import { createFileRoute } from '@tanstack/react-router';
import { ArrowLeft, Download, Loader2, Trash2 } from 'lucide-react';
import { Link } from '@/components/ui/app-link';
import { useRouter } from '@/lib/next-compat/navigation';
import { useState } from 'react';
import { TranscriptPanel } from '@/components/transcript/transcript-panel';
import { useCapture } from '@/lib/api/use-captures';
import { cn, formatBytes, formatDuration } from '@/lib/utils';
import { AppAlert, AppPage, appButton } from '@/components/ui/app-page';
import { refreshLibrary } from '@/lib/api/use-library';

export const Route = createFileRoute('/app/captures/$id')({
  component: CaptureDetailPage,
});

function CaptureDetailPage() {
  const { id } = Route.useParams();
  const router = useRouter();
  const { data, loading, error } = useCapture(id);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/captures/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      refreshLibrary();
      await router.push('/app?tab=captures');
    } catch (err) {
      setDeleting(false);
      setDeleteError(err instanceof Error ? err.message : 'delete failed');
    }
  }

  return (
    <AppPage width="reading" className="gap-4">
      <Link
        href="/app?tab=captures"
        className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Library
      </Link>

      {error ? (
        <AppAlert>
          {error.message}
        </AppAlert>
      ) : loading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight">{data.title}</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {new Date(data.createdAt).toLocaleString()} · {formatBytes(data.bytes)}
                {data.durationSec ? ` · ${formatDuration(data.durationSec * 1000)}` : ''}
                {data.width && data.height ? ` · ${data.width}×${data.height}` : ''}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <a
                href={data.url}
                download
                className={appButton('secondary', 'sm')}
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(true);
                }}
                disabled={deleting}
                aria-label="Delete capture"
                className={cn(appButton('ghost', 'sm'), 'hover:text-danger')}
              >
                {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {confirmingDelete ? (
            <div role="alertdialog" aria-labelledby="delete-capture-title" className="flex flex-col gap-3 rounded-md border border-danger/25 bg-danger-soft px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 id="delete-capture-title" className="text-sm font-semibold text-danger">Delete this capture permanently?</h2>
                <p className="mt-0.5 text-xs text-danger/80">The media and its transcript cannot be recovered.</p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setConfirmingDelete(false)} disabled={deleting} className={appButton('ghost', 'sm')}>Cancel</button>
                <button type="button" onClick={() => void handleDelete()} disabled={deleting} className={appButton('danger', 'sm')}>
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Delete
                </button>
              </div>
            </div>
          ) : null}

          {deleteError ? <AppAlert>{deleteError}</AppAlert> : null}

          <div className="flex items-center justify-center overflow-hidden rounded-lg bg-black/90">
            {data.kind === 'image' ? (
              <img src={data.url} alt={data.title} className="max-h-[70vh] w-auto rounded" />
            ) : (
              <video src={data.url} controls autoPlay={false} className="max-h-[70vh] w-auto rounded" />
            )}
          </div>

          <TranscriptPanel
            title={data.kind === 'image' ? 'Extracted text' : 'Transcript'}
            status={data.transcriptStatus}
            transcript={data.transcript}
            error={data.transcriptError}
          />
        </>
      )}
    </AppPage>
  );
}
