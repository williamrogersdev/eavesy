'use client';

import {
  Copy,
  CornerDownLeft,
  Download,
  FileText,
  FolderOpen,
  Globe,
  Sparkles,
} from 'lucide-react';
import { useMemo } from 'react';
import { copyText, pasteToFrontmost, revealInFinder } from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import { type Action, type Flash, type Item, type RunTask } from './types';
import { downloadMarkdown, recordingMarkdown } from './format';
import { agentText } from './capture-history';

export function useRecordingActions({
  current,
  currentRec,
  desktop,
  flash,
  runTask,
  setActionsOpen,
  openRecording,
}: {
  current: Item | undefined;
  currentRec: Recording | null;
  desktop: boolean;
  flash: Flash;
  runTask: RunTask;
  setActionsOpen: (open: boolean) => void;
  openRecording: (rec: Recording) => void;
}) {
  return useMemo<Action[]>(() => {
    if (current?.kind === 'command') {
      return [
        {
          id: 'run',
          label: `Run “${current.title}”`,
          icon: <CornerDownLeft className="h-4 w-4" />,
          hint: '↵',
          run: current.run,
        },
      ];
    }
    if (!currentRec) return [];
    const rec = currentRec;
    const transcript = rec.transcript ?? '';
    const summary = rec.summary ?? '';
    const close = () => setActionsOpen(false);
    return [
      {
        id: 'paste',
        label: 'Paste transcript into active app',
        icon: <CornerDownLeft className="h-4 w-4" />,
        hint: '⌘↵',
        run: async () => {
          await pasteToFrontmost(transcript);
          close();
          if (!desktop) flash('Transcript copied — paste anywhere');
        },
      },
      {
        id: 'copy-transcript',
        label: 'Copy transcript',
        icon: <Copy className="h-4 w-4" />,
        hint: '⌘C',
        run: async () => {
          await copyText(transcript);
          close();
          flash('Transcript copied');
        },
      },
      {
        id: 'copy-summary',
        label: 'Copy summary',
        icon: <FileText className="h-4 w-4" />,
        hint: '⌘⇧C',
        run: async () => {
          await copyText(summary || transcript);
          close();
          flash('Summary copied');
        },
      },
      {
        id: 'copy-md',
        label: 'Copy as Markdown',
        icon: <Copy className="h-4 w-4" />,
        run: async () => {
          await copyText(recordingMarkdown(rec));
          close();
          flash('Markdown copied');
        },
      },
      {
        id: 'ask-ai',
        label: 'Copy for AI',
        icon: <Sparkles className="h-4 w-4" />,
        hint: '⌘J',
        run: async () => {
          const { text, cleaned } = await agentText(rec);
          await copyText(text);
          close();
          flash(cleaned ? 'Copied for AI' : 'Copied. The cleaned-up version isn’t ready yet');
        },
      },
      {
        id: 'download',
        label: 'Download as Markdown',
        icon: <Download className="h-4 w-4" />,
        hint: '⌘D',
        run: () => {
          downloadMarkdown(rec);
          close();
        },
      },
      ...(desktop
        ? [
            {
              id: 'reveal',
              label: 'Reveal in Finder',
              icon: <FolderOpen className="h-4 w-4" />,
              hint: '⌘⇧R',
              run: () => {
                runTask(() => revealInFinder(rec.id), 'Could not reveal recording');
                close();
              },
            } as Action,
          ]
        : []),
      {
        id: 'open',
        label: 'Open recording',
        icon: <Globe className="h-4 w-4" />,
        run: () => openRecording(rec),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, currentRec, desktop, flash, runTask]);
}
