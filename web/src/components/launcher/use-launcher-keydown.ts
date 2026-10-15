import { useCallback, type Dispatch, type SetStateAction, type RefObject } from 'react';
import { copyText, hidePanel, pasteToFrontmost } from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import { type Action, type Flash, type Item, type LauncherView, type RunTask } from './types';
import { downloadMarkdown } from './format';

export function useLauncherKeyDown({
  desktop,
  view,
  setView,
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
  pasteFromClipboard,
  flash,
  runTask,
}: {
  desktop: boolean;
  view: LauncherView;
  setView: Dispatch<SetStateAction<LauncherView>>;
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
  pasteFromClipboard: () => void;
  flash: Flash;
  runTask: RunTask;
}) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (meta && e.key === ',') { e.preventDefault(); goSettings(); return; }
      if (desktop && view === 'list' && meta && e.key.toLowerCase() === 'v' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        pasteFromClipboard();
        return;
      }
      if (view === 'settings') {
        if (e.key === 'Escape') { e.preventDefault(); setView('list'); }
        return;
      }
      if (view === 'setup') {
        if (e.key === 'Escape' && desktop) {
          e.preventDefault();
          runTask(hidePanel, 'Could not close the launcher');
        }
        return;
      }
      if (view === 'context') {
        if (e.key === 'Escape') {
          e.preventDefault();
          setView('list');
        }
        return;
      }

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
            () => pasteToFrontmost(currentRec.transcript ?? ''),
            'Could not paste transcript',
          );
          if (!desktop) flash('Transcript copied — paste anywhere');
        } else {
          runPrimary();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (query) {
          setQuery('');
        } else if (desktop) {
          runTask(hidePanel, 'Could not close the launcher');
        }
        return;
      }
      if (meta && currentRec) {
        const k = e.key.toLowerCase();
        if (k === 'c' && !e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(currentRec.transcript ?? '');
            flash('Transcript copied');
          }, 'Could not copy transcript');
        } else if (k === 'c' && e.shiftKey) {
          e.preventDefault();
          runTask(async () => {
            await copyText(currentRec.summary ?? currentRec.transcript ?? '');
            flash('Summary copied');
          }, 'Could not copy summary');
        } else if (k === 'd') {
          e.preventDefault();
          downloadMarkdown(currentRec);
        } else if (k === 'j') {
          e.preventDefault();
          runTask(async () => {
            await copyText(
              `Here is a meeting transcript. Summarize the key decisions and action items.\n\n---\n${currentRec.transcript ?? ''}`,
            );
            flash('Prompt copied');
          }, 'Could not copy prompt');
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
      desktop,
      view,
      runPrimary,
      goSettings,
      openActions,
      flash,
      runTask,
      pasteFromClipboard,
      setView,
      setActionsOpen,
      setActionsSel,
      setSelected,
      setQuery,
      searchRef,
    ],
  );
}
