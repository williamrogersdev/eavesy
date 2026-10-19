'use client';

import { Check, ChevronDown, Crosshair, FolderOpen, FolderPlus, FolderX, Settings2 } from 'lucide-react';
import { openWebApp } from '@/lib/desktop/bridge';
import { Menu, type MenuItem } from './ui';
import type { RunTask } from './types';
import type { ProjectChoice } from './use-project';

/**
 * Which project the next recording goes into. Auto follows the window in
 * front (a repo name in Cursor or Terminal); picking a project pins it.
 */
export function ProjectChip({ choice, runTask }: { choice: ProjectChoice; runTask: RunTask }) {
  const { projects, mode, active, detected, front, setMode } = choice;
  const manage: MenuItem = {
    label: projects.length ? 'Manage projects…' : 'Create a project…',
    icon: projects.length ? Settings2 : FolderPlus,
    onSelect: () => runTask(() => openWebApp('/settings#projects'), 'Couldn’t open eavesy.com'),
  };
  const items: MenuItem[] = projects.length
    ? [
        {
          id: 'auto',
          label: detected ? `Follow the app in front · ${detected.name}` : 'Follow the app in front',
          icon: mode === 'auto' ? Check : Crosshair,
          onSelect: () => setMode('auto'),
        },
        'separator',
        ...projects.map((project): MenuItem => ({
          id: project.id,
          label: project.name,
          icon: typeof mode === 'object' && mode.pinned === project.id ? Check : FolderOpen,
          onSelect: () => setMode({ pinned: project.id }),
        })),
        { id: 'none', label: 'No project', icon: mode === 'none' ? Check : FolderX, onSelect: () => setMode('none') },
        'separator',
        manage,
      ]
    : [manage];
  const where = front?.app ? `${front.app}${front.title ? `: ${front.title}` : ''}` : null;
  const title = mode === 'auto'
    ? active
      ? `Recordings go into ${active.name}, picked from ${where ?? 'the app in front'}`
      : `No project matches ${where ?? 'the app in front'}`
    : active
      ? `Recordings go into ${active.name}`
      : 'Recordings have no project';
  return (
    <Menu
      align="end"
      items={items}
      header={projects.length ? <div className="ev-menu-header-sub">Next recording’s project</div> : undefined}
      trigger={
        <button type="button" className="ev-chip ev-proj" aria-label={`Project: ${active?.name ?? 'none'}`} title={title}>
          <FolderOpen size={13} strokeWidth={1.75} aria-hidden />
          <span className="ev-proj-name">{active?.name ?? (projects.length ? 'No project' : 'Project')}</span>
          {mode === 'auto' && active && <span className="ev-proj-auto">auto</span>}
          <ChevronDown size={11} strokeWidth={2} aria-hidden />
        </button>
      }
    />
  );
}
