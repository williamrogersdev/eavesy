import { createFileRoute } from '@tanstack/react-router';
import { handleFeedback } from '@/server/agent-feedback';

/** What agents reported over MCP: GET lists the open reports, PATCH dismisses some. */
export const Route = createFileRoute('/api/agent-feedback/')({ server: { handlers: {
  GET: ({ request }) => handleFeedback(request),
  PATCH: ({ request }) => handleFeedback(request),
} } });
