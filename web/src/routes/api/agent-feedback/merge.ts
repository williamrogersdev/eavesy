import { createFileRoute } from '@tanstack/react-router';
import { handleMerge } from '@/server/agent-feedback';

/** One proposed rewrite of a prompt from the agents' reports on it, to preview. Stores nothing. */
export const Route = createFileRoute('/api/agent-feedback/merge')({ server: { handlers: {
  POST: ({ request }) => handleMerge(request),
} } });
