import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { useRouter } from '@/lib/next-compat/navigation';
import { Recorder } from '@/components/recorder/recorder';
import { AppPage, AppPageHeader } from '@/components/ui/app-page';

export const Route = createFileRoute('/app/record')({
  validateSearch: (search: Record<string, unknown>): { first?: true } =>
    search.first === true || search.first === '1' ? { first: true } : {},
  component: RecordPage,
});

function RecordPage() {
  const router = useRouter();
  const { first } = Route.useSearch();
  const [stage, setStage] = useState<'idle' | 'opening'>('idle');
  return (
    <AppPage width="compact">
      <AppPageHeader
        title={first ? 'Your first brief' : 'Record'}
        description={first
          ? 'Talk for a minute about something you’re working on. Eavesy turns it into context you can hand to an AI.'
          : 'Voice notes or whole meetings. Your transcript and brief are ready shortly after you stop.'}
      />
      <Recorder
        onSaved={async (meetingId) => {
          setStage('opening');
          await router.push(`/app/meetings/${meetingId}${first ? '?first=1' : ''}`);
        }}
      />
      <div aria-live="polite">
        {stage === 'opening' ? <p className="text-sm text-muted-foreground">Opening your transcript and brief…</p> : null}
      </div>
    </AppPage>
  );
}
