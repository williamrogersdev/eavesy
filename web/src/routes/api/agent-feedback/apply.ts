import { createFileRoute } from '@tanstack/react-router';
import { handleApply } from '@/server/agent-feedback';

/** Writes a rewrite the user accepted into their prompt, if it hasn't changed since the preview. */
export const Route = createFileRoute('/api/agent-feedback/apply')({ server: { handlers: {
  POST: ({ request }) => handleApply(request),
} } });
