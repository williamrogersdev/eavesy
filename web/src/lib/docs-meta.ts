import type { ComponentType } from 'react';
import {
  BookOpen,
  Bot,
  FileText,
  FolderTree,
  LifeBuoy,
  Mic,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { GithubMark } from '@/components/github-mark';
import { siteConfig } from '@/lib/site';

export interface CategoryMeta {
  icon: ComponentType<{ className?: string }>;
  blurb: string;
}

const CATEGORY_META: Record<string, CategoryMeta> = {
  'Getting started': {
    icon: Rocket,
    blurb: 'Install the Mac app, grant permissions, and make your first capture.',
  },
  Capturing: {
    icon: Mic,
    blurb: 'Talk, meetings, video, screenshots, clipboard and the web app.',
  },
  'Transcripts and briefs': {
    icon: FileText,
    blurb: 'Captions, transcripts, language, custom words, briefs, search and chat.',
  },
  'Your files': {
    icon: FolderTree,
    blurb: 'The folders and files Eavesy writes to your disk.',
  },
  Agents: {
    icon: Bot,
    blurb: 'Paste context, point an agent at your folder, or connect over MCP.',
  },
  'Account and data': {
    icon: ShieldCheck,
    blurb: 'Privacy, your own AI keys, export, deletion and fair-use limits.',
  },
  'Open source': {
    icon: GithubMark,
    blurb: 'The licence, the repository, self-hosting and contributing.',
  },
  Help: {
    icon: LifeBuoy,
    blurb: 'Shortcuts, fixes for common problems, and quick answers.',
  },
};

const FALLBACK: CategoryMeta = {
  icon: BookOpen,
  blurb: 'Guides and reference for Eavesy.',
};

export function categoryMeta(category: string): CategoryMeta {
  return Object.hasOwn(CATEGORY_META, category) ? CATEGORY_META[category] : FALLBACK;
}

export const DOCS_REPO_EDIT_BASE = `${siteConfig.github}/edit/main/web/src/content/docs`;

export function docEditUrl(slug: string): string {
  return `${DOCS_REPO_EDIT_BASE}/${slug}.mdx`;
}

export const DOC_REDIRECTS: Record<string, string> = {
  'plans-and-billing': 'fair-use-limits',
  'recording-your-first-meeting': 'meetings',
  'capturing-screen-and-audio': 'meetings',
  'integrations-overview': 'meetings',
  'exporting-and-files': 'session-folder-format',
  'finding-past-sessions': 'search-and-chat',
};
