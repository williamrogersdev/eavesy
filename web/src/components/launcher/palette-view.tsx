'use client';

import {
  ClipboardPaste,
  Copy,
  Download,
  Keyboard,
  Mic,
  MoreHorizontal,
  Radio,
  Search,
  Video,
} from 'lucide-react';
import { type RefObject } from 'react';
import { copyText, recordingContext, pasteToFrontmost } from '@/lib/desktop/bridge';
import type { Recording } from '@/lib/launcher/types';
import { type Action, type BeginRecording, type Flash, type Item, type RunTask } from './types';
import { downloadMarkdown } from './format';
import { Preview, RecordButton, Row, SectionLabel, ToolbarBtn } from './palette-parts';
import { ActionsMenu } from './actions-menu';

export function PaletteView({
  desktop,
  setupPaired,
  query,
  setQuery,
  selected,
  setSelected,
  items,
  commandCount,
  now,
  current,
  currentRec,
  searchRef,
  listRef,
  runPrimary,
  flash,
  runTask,
  actionsOpen,
  setActionsOpen,
  openActions,
  actionsQuery,
  setActionsQuery,
  actionsSel,
  setActionsSel,
  actionsInputRef,
  filteredActions,
  onKeyDown,
  beginMeetingRecording,
  beginRecording,
  goSettings,
  toggleHotkey,
}: {
  desktop: boolean;
  setupPaired: boolean;
  query: string;
  setQuery: (query: string) => void;
  selected: number;
  setSelected: (selected: number) => void;
  items: Item[];
  commandCount: number;
  now: number;
  current: Item | undefined;
  currentRec: Recording | null;
  searchRef: RefObject<HTMLInputElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  runPrimary: () => void;
  flash: Flash;
  runTask: RunTask;
  actionsOpen: boolean;
  setActionsOpen: (open: boolean) => void;
  openActions: () => void;
  actionsQuery: string;
  setActionsQuery: (query: string) => void;
  actionsSel: number;
  setActionsSel: (selected: number) => void;
  actionsInputRef: RefObject<HTMLInputElement | null>;
  filteredActions: Action[];
  onKeyDown: (e: React.KeyboardEvent) => void;
  beginMeetingRecording: () => void;
  beginRecording: BeginRecording;
  goSettings: () => void;
  toggleHotkey: string;
}) {
  return (
    <>
    {!query && (
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <RecordButton icon={<Radio className="h-4 w-4" />} label="Record meeting" primary onClick={beginMeetingRecording} />
        <RecordButton icon={<Mic className="h-4 w-4" />} label="Dictate" onClick={() => runTask(() => beginRecording('audio', { source: 'mic', dictation: true }))} />
        <span className="ml-auto text-[11px] text-muted-foreground">{desktop ? (setupPaired ? 'Cloud connected' : 'Local only · Connect in Settings') : 'Record, find, and reuse your conversations'}</span>
      </div>
    )}
    <div className="flex items-center gap-3 border-b border-border px-4">
      <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
      <input
        ref={searchRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
        placeholder="Search recordings, transcripts, commands…"
        spellCheck={false}
        autoComplete="off"
        className="h-14 w-full bg-transparent text-[17px] text-foreground caret-[var(--lr-brand)] outline-none placeholder:text-muted-foreground"
      />
      {!query && (
        <div className="lr-eq shrink-0 pr-0.5" aria-hidden="true">
          <i style={{ height: '40%', animationDelay: '0ms' }} />
          <i style={{ height: '90%', animationDelay: '130ms' }} />
          <i style={{ height: '55%', animationDelay: '260ms' }} />
          <i style={{ height: '100%', animationDelay: '80ms' }} />
          <i style={{ height: '45%', animationDelay: '340ms' }} />
        </div>
      )}
    </div>

    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div
        ref={listRef}
        className="launcher-list min-h-0 overflow-y-auto border-r border-border py-2"
      >
        {items.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {query ? `No matches for “${query}”.` : 'Your recordings will appear here. Start a meeting or dictate above.'}
          </p>
        )}
        {items.map((item, i) => {
          const isFirstRec =
            item.kind === 'recording' && i === commandCount;
          const isFirstCmd = item.kind === 'command' && i === 0;
          return (
            <div key={item.id}>
              {isFirstCmd && <SectionLabel>Commands</SectionLabel>}
              {isFirstRec && <SectionLabel>Recordings</SectionLabel>}
              <Row
                item={item}
                now={now}
                active={i === selected}
                idx={i}
                onClick={() => setSelected(i)}
                onDoubleClick={() => runPrimary()}
              />
            </div>
          );
        })}
      </div>

      <div className="relative flex min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-1.5 border-b border-border px-3">
          {currentRec ? (
            <>
              <span />
              <div className="flex items-center gap-1.5">
                <ToolbarBtn
                  title="Copy"
                  onClick={() =>
                    runTask(async () => {
                      await copyText(await recordingContext(currentRec.id, currentRec.transcript ?? ''));
                      flash('Transcript copied');
                    }, 'Could not copy transcript')
                  }
                >
                  <Copy className="h-4 w-4" />
                </ToolbarBtn>
                <ToolbarBtn
                  title="Paste into active app"
                  onClick={() => {
                    runTask(
                      async () => pasteToFrontmost(await recordingContext(currentRec.id, currentRec.transcript ?? ''), !currentRec.hasVideo),
                      'Could not paste transcript',
                    );
                    if (!desktop) flash('Transcript copied — paste anywhere');
                  }}
                >
                  <ClipboardPaste className="h-4 w-4" />
                </ToolbarBtn>
                <ToolbarBtn
                  title="Download as Markdown"
                  onClick={() => downloadMarkdown(currentRec)}
                >
                  <Download className="h-4 w-4" />
                </ToolbarBtn>
                <ToolbarBtn
                  title="More actions"
                  active={actionsOpen}
                  onClick={() =>
                    actionsOpen ? setActionsOpen(false) : openActions()
                  }
                >
                  <MoreHorizontal className="h-4 w-4" />
                </ToolbarBtn>
              </div>
            </>
          ) : (
            <>
              <span className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                New recording
              </span>
              <div className="flex items-center gap-2">
                <RecordButton
                  icon={<Mic className="h-4 w-4" />}
                  label="Audio"
                  primary
                  onClick={beginMeetingRecording}
                />
                <RecordButton
                  icon={<Video className="h-4 w-4" />}
                  label="Screen"
                  onClick={() =>
                    runTask(
                      () => beginRecording('screen', { mic: false }),
                      'Could not start screen recording',
                    )
                  }
                />
              </div>
            </>
          )}
        </div>

        <Preview
          rec={currentRec}
          command={current?.kind === 'command' ? current : null}
          now={now}
        />

        {actionsOpen && (
          <ActionsMenu
            actions={filteredActions}
            selected={actionsSel}
            query={actionsQuery}
            inputRef={actionsInputRef}
            onQuery={(v) => {
              setActionsQuery(v);
              setActionsSel(0);
            }}
            onHover={setActionsSel}
            onRun={(action) => runTask(action.run)}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
    </div>

    <div className="flex h-12 items-center justify-between border-t border-border px-4">
      <div className="flex items-center gap-2">
        <span
          className="grid h-5 w-5 place-items-center rounded-full"
          style={{ background: 'var(--lr-brand-soft)' }}
          aria-hidden="true"
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: 'var(--lr-brand)' }}
          />
        </span>
        <span className="text-[13px] font-medium text-foreground">
          Eavesy
        </span>
      </div>
      <button
        type="button"
        onClick={goSettings}
        title="Change your launcher hotkey"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted-foreground hover:bg-[var(--lr-hover)]"
      >
        <Keyboard className="h-4 w-4" />
        <span>Settings · Open</span>
        <span
          className="rounded-md border px-1.5 py-0.5 font-round text-[12px] text-foreground"
          style={{
            borderColor:
              'color-mix(in srgb, var(--lr-brand) 45%, var(--border))',
          }}
        >
          {toggleHotkey}
        </span>
      </button>
    </div>
    </>
  );
}
