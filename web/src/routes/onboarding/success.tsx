import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/onboarding/success')({
  beforeLoad: () => {
    throw redirect({ to: '/app' });
  },
});
