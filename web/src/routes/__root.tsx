/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from '@tanstack/react-router';
import { ClerkProvider } from '@clerk/tanstack-react-start';
import { useEffect, type ReactNode } from 'react';
import { siteConfig } from '@/lib/site';
import appCss from '@/styles/globals.css?url';
import { RootError, RootNotFound } from '@/components/ui/root-fallbacks';
import { initBrowserErrorReporting } from '@/lib/observability/browser';

export const Route = createRootRoute({
  errorComponent: RootError,
  notFoundComponent: RootNotFound,
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: `${siteConfig.name} — ${siteConfig.tagline}` },
      { name: 'description', content: siteConfig.description },
      { name: 'application-name', content: siteConfig.name },
      {
        name: 'keywords',
        content: [
          'context capture for ai',
          'ai agent context',
          'context for ai coding agents',
          'screen and voice recorder',
          'paste context into claude',
          'ai meeting notes',
          'bot-free recorder',
          'markdown transcript',
        ].join(', '),
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: siteConfig.name },
      { property: 'og:url', content: siteConfig.url },
      { property: 'og:title', content: `${siteConfig.name} — ${siteConfig.tagline}` },
      { property: 'og:description', content: siteConfig.description },
      { property: 'og:image', content: `${siteConfig.url}/og.png` },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: `${siteConfig.name} — ${siteConfig.tagline}` },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: `${siteConfig.name} — ${siteConfig.tagline}` },
      { name: 'twitter:description', content: siteConfig.shortDescription },
      { name: 'twitter:image', content: `${siteConfig.url}/og.png` },
      { name: 'twitter:creator', content: siteConfig.twitter },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', type: 'image/svg+xml', href: '/icon.svg' },
      { rel: 'apple-touch-icon', href: '/apple-icon.png' },
      { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
      { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&display=swap',
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  useEffect(initBrowserErrorReporting, []);
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        {import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ? (
          <ClerkProvider
            signInFallbackRedirectUrl="/app"
            signUpFallbackRedirectUrl="/app"
          >
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
        <Scripts />
      </body>
    </html>
  );
}
