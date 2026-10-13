import { clerkMiddleware } from '@clerk/tanstack-react-start/server';
import { createStart } from '@tanstack/react-start';

const hasClerkKey = Boolean(
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ||
    (typeof process !== 'undefined' && process.env?.CLERK_PUBLISHABLE_KEY),
);

export const startInstance = createStart(() => {
  return {
    requestMiddleware: hasClerkKey ? [clerkMiddleware()] : [],
  };
});
