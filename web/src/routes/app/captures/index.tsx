import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/app/captures/')({
  beforeLoad: () => {
    throw redirect({ to: '/app', search: { tab: 'captures' } });
  },
});
