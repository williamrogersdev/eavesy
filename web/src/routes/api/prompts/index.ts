import { createFileRoute } from '@tanstack/react-router';
import { handlePrompts } from '@/server/prompts';

export const Route = createFileRoute('/api/prompts/')({ server: { handlers: {
  GET: ({ request }) => handlePrompts(request),
  POST: ({ request }) => handlePrompts(request),
} } });
