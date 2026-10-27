import { createFileRoute } from '@tanstack/react-router';
import { handlePrompts } from '@/server/prompts';

export const Route = createFileRoute('/api/prompts/$id')({ server: { handlers: {
  PATCH: ({ request, params }) => handlePrompts(request, params.id),
  DELETE: ({ request, params }) => handlePrompts(request, params.id),
} } });
