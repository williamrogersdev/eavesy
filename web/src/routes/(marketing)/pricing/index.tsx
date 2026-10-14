import { createFileRoute, redirect } from '@tanstack/react-router';

// Billing was removed; keep old inbound links working.
export const Route = createFileRoute('/(marketing)/pricing/')({
  beforeLoad: () => {
    throw redirect({ to: '/', statusCode: 301 });
  },
});
