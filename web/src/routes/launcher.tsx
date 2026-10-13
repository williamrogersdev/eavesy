import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Launcher } from '@/components/launcher/launcher';

export const Route = createFileRoute('/launcher')({
  head: () => ({
    meta: [{ name: 'robots', content: 'noindex, nofollow' }],
  }),
  component: LauncherPage,
});

function LauncherPage() {
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prev = { html: html.style.background, body: body.style.background };
    html.style.background = 'transparent';
    body.style.background = 'transparent';
    return () => {
      html.style.background = prev.html;
      body.style.background = prev.body;
    };
  }, []);

  return <Launcher />;
}
