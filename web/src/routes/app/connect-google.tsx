import { createFileRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { AppPage, AppPageHeader } from '@/components/ui/app-page';

export const Route = createFileRoute('/app/connect-google')({ component: ConnectGoogle });

/**
 * Where the Mac app's "Connect Google" button lands (`#mac`): the /app gate has
 * signed the browser in, so this hands straight over to Google.
 */
function ConnectGoogle() {
  useEffect(() => {
    const fromMac = window.location.hash === '#mac';
    window.location.replace(`/api/connections/google${fromMac ? '?from=mac' : ''}`);
  }, []);
  return (
    <AppPage>
      <AppPageHeader title="Opening Google…" />
    </AppPage>
  );
}
