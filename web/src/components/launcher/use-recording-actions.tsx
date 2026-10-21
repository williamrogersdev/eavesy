'use client';

import {
  Copy,
  CornerDownLeft,
  Download,
  FileText,
  FolderOpen,
  Globe,
} from 'lucide-react';
import { useMemo } from 'react';
import { copyText, recordingContext, pasteToFrontmost, revealInFinder, retryWalkthrough } from '@/lib/desktop/bridge';
import { loadRecordingDetails } from '@/lib/launcher/data';
import type { Recording } from '@/lib/launcher/types';
import { type Action, type Flash, type Item, type RunTask } from './types';
import { downloadMarkdown, recordingMarkdown } from './format';

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
    const close = () => setActionsOpen(false);
    return [
      {
        id: 'paste',
        label: 'Paste into active app',
        icon: <CornerDownLeft className="h-4 w-4" />,
        hint: '⌘↵',
        run: async () => {
          await pasteToFrontmost(await recordingContext(rec.id, (await loadRecordingDetails(rec)).transcript ?? ''), !rec.hasVideo);
          close();
          if (!desktop) flash('Transcript copied — paste anywhere');
        },
      },
      {
        id: 'copy-transcript',
        label: 'Copy',
        icon: <Copy className="h-4 w-4" />,
        hint: '⌘C',
        run: async () => {
          await copyText(await recordingContext(rec.id, (await loadRecordingDetails(rec)).transcript ?? ''));
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
          const detail = await loadRecordingDetails(rec);
          await copyText(detail.summary || detail.transcript || '');
          close();
          flash('Summary copied');
        },
      },
      {
        id: 'copy-md',
        label: 'Copy as Markdown',
        icon: <Copy className="h-4 w-4" />,
        run: async () => {
          await copyText(recordingMarkdown(await loadRecordingDetails(rec)));
          close();
          flash('Markdown copied');
        },
      },
      ...(desktop && rec.hasVideo ? [{
        id: 'retry-walkthrough', label: 'Prepare walkthrough context', icon: <FileText className="h-4 w-4" />,
        run: async () => { await retryWalkthrough(rec.id); close(); flash('Preparing context…'); },
      }] : []),
      {
        id: 'download',
        label: 'Download as Markdown',
        icon: <Download className="h-4 w-4" />,
        hint: '⌘D',
        run: async () => {
          downloadMarkdown(await loadRecordingDetails(rec));
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
