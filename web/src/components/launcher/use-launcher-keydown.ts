import { useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { copyText, recordingContext, pasteToFrontmost } from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import { type Action, type Flash, type Item, type RunTask } from './types';
import { downloadMarkdown } from './format';

/** Keys for the web palette: arrows pick, Return opens, ⌘K shows actions, Esc clears. */
export function useLauncherKeyDown({
  actionsOpen,
  setActionsOpen,
  actionsSel,
  setActionsSel,
  setSelected,
  setQuery,
  query,
  items,
  filteredActions,
  currentRec,
  searchRef,
  runPrimary,
  goSettings,
  openActions,
  flash,
  runTask,
}: {
  actionsOpen: boolean;
  setActionsOpen: (open: boolean) => void;
  actionsSel: number;
  setActionsSel: Dispatch<SetStateAction<number>>;
  setSelected: Dispatch<SetStateAction<number>>;
  setQuery: (query: string) => void;
  query: string;
  items: Item[];
  filteredActions: Action[];
  currentRec: Recording | null;
  searchRef: RefObject<HTMLInputElement | null>;
  runPrimary: () => void;
  goSettings: () => void;
  openActions: () => void;
  flash: Flash;
  runTask: RunTask;
}) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === ',') { e.preventDefault(); goSettings(); return; }

      if (actionsOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setActionsOpen(false);
          searchRef.current?.focus();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActionsSel((s) => (s + 1) % Math.max(1, filteredActions.length));
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActionsSel(
            (s) =>
              (s - 1 + filteredActions.length) %
              Math.max(1, filteredActions.length),
          );
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const action = filteredActions[actionsSel];
          if (action) runTask(action.run);
        } else if (meta && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          setActionsOpen(false);
        }
        return;
      }

      if (meta && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openActions();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => (items.length ? (s + 1) % items.length : 0));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) =>
          items.length ? (s - 1 + items.length) % items.length : 0,
        );
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (meta && currentRec) {
          runTask(
            async () => pasteToFrontmost(await recordingContext(currentRec.id, currentRec.transcript ?? ''), !currentRec.hasVideo),
            'Couldn’t paste the transcript',
          );
          flash('Transcript copied — paste anywhere');
        } else {
          runPrimary();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (query) setQuery('');
        return;
      }
      if (meta && currentRec) {
        const k = e.key.toLowerCase();
        if (k === 'c' && !e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(await recordingContext(currentRec.id, currentRec.transcript ?? ''));
            flash('Transcript copied');
          }, 'Couldn’t copy the transcript');
        } else if (k === 'c' && e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(currentRec.summary ?? currentRec.transcript ?? '');
            flash('Summary copied');
          }, 'Couldn’t copy the summary');
        } else if (k === 'd') {
          e.preventDefault();
          downloadMarkdown(currentRec);
        }
      }
    },
    [
      actionsOpen,
      filteredActions,
      actionsSel,
      items.length,
      currentRec,
      query,
      runPrimary,
      goSettings,
      openActions,
      flash,
      runTask,
      setActionsOpen,
      setActionsSel,
      setSelected,
      setQuery,
      searchRef,
    ],
  );
}
