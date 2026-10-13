import { createFileRoute } from '@tanstack/react-router';
import { MeetingView } from '@/components/meeting/meeting-view';

export const Route = createFileRoute('/app/meetings/$id')({
  validateSearch: (search: Record<string, unknown>): { first?: true } =>
    search.first === true || search.first === '1' ? { first: true } : {},
  component: MeetingDetailPage,
});

function MeetingDetailPage() {
  const { id } = Route.useParams();
  const { first } = Route.useSearch();
  return <MeetingView meetingId={id} firstRun={first} />;
}
