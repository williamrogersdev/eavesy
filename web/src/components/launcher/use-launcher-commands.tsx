'use client';

import { Globe, Languages, Mic, Pencil, Radio, Settings, Video } from 'lucide-react';
import { useRouter } from '@/lib/next-compat/navigation';
import { useMemo } from 'react';
import { hidePanel } from '@/lib/desktop/bridge';
import { type BeginRecording, type Command, type RunTask } from './types';

export function useLauncherCommands({
  desktop,
  router,
  runTask,
  beginRecording,
  beginMeetingRecording,
  connectAccount,
  goSettings,
}: {
  desktop: boolean;
  router: ReturnType<typeof useRouter>;
  runTask: RunTask;
  beginRecording: BeginRecording;
  beginMeetingRecording: () => void;
  connectAccount: () => Promise<void>;
  goSettings: () => void;
}) {
  return useMemo<Command[]>(() => {
    const go = (href: string) => () => {
      if (desktop) runTask(hidePanel, 'Could not close the launcher');
      runTask(() => router.push(href), 'Could not open that page');
    };
    return [
      { kind: 'command', id: 'cmd-translate', title: 'Translate', subtitle: 'Speak or paste, then copy in another language', icon: <Languages className="h-4 w-4" />, keywords: 'translate language english spanish', run: go('/app/translate') },
      {
        kind: 'command',
        id: 'cmd-connect',
        title: 'Connect Eavesy account',
        subtitle: 'Pair this Mac for cloud transcription and sync',
        icon: <Globe className="h-4 w-4" />,
        keywords: 'connect account pair login sync cloud',
        run: () => runTask(connectAccount, 'Could not connect account'),
      },
      {
        kind: 'command',
        id: 'cmd-record',
        title: 'Record audio',
        subtitle: 'Capture system audio + microphone',
        icon: <Radio className="h-4 w-4" />,
        keywords: 'record capture meeting audio new mic',
        run: beginMeetingRecording,
      },
      {
        kind: 'command',
        id: 'cmd-screen',
        title: 'Record screen',
        subtitle: 'Screen + audio, Loom-style — with transcript',
        icon: <Video className="h-4 w-4" />,
        keywords: 'record screen video loom capture share demo',
        run: () =>
          runTask(
            () => beginRecording('screen', { mic: false }),
            'Could not start screen recording',
          ),
      },
      {
        kind: 'command',
        id: 'cmd-dictate',
        title: 'Start dictation',
        subtitle: 'Record your voice, then copy or paste the transcript',
        icon: <Mic className="h-4 w-4" />,
        keywords: 'dictate voice type speech',
        run: () =>
          runTask(
            () => beginRecording('audio', { source: 'mic', dictation: true }),
            'Could not start dictation',
          ),
      },
      {
        kind: 'command',
        id: 'cmd-note',
        title: 'New note',
        subtitle: 'Start an empty note',
        icon: <Pencil className="h-4 w-4" />,
        keywords: 'note write text new',
        run: go('/app/record'),
      },
      {
        kind: 'command',
        id: 'cmd-dashboard',
        title: 'Open dashboard',
        subtitle: 'All recordings on the web',
        icon: <Globe className="h-4 w-4" />,
        keywords: 'dashboard web app open all',
        run: go('/app'),
      },
      {
        kind: 'command',
        id: 'cmd-settings',
        title: 'Settings & hotkeys',
        subtitle: 'Change your global shortcut',
        icon: <Settings className="h-4 w-4" />,
        keywords: 'settings hotkey shortcut preferences config',
        run: goSettings,
      },
    ];
  }, [
    desktop,
    router,
    beginRecording,
    beginMeetingRecording,
    connectAccount,
    goSettings,
    runTask,
  ]);
}
