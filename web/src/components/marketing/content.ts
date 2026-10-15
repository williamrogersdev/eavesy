import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  Cloud,
  FileText,
  FolderTree,
  Languages,
  ListChecks,
  Lock,
  Mic,
  Radio,
  Search,
  Zap,
} from 'lucide-react';

export interface NavChild {
  label: string;
  href: string;
  desc?: string;
}
export interface NavItem {
  label: string;
  href: string;
  children?: NavChild[];
}

export const PRIMARY_NAV: NavItem[] = [
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Docs', href: '/docs' },
];

export const INTEGRATIONS = [
  'Claude', 'Cursor', 'ChatGPT', 'Any MCP client', 'Obsidian', 'VS Code', 'Terminal', 'Plain Markdown',
];

export type ShowcaseVisual = 'capture' | 'summary' | 'files';

export interface Showcase {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  flip: boolean;
  visual: ShowcaseVisual;
}

export const SHOWCASES: Showcase[] = [
  {
    icon: Radio,
    eyebrow: 'Drop things in',
    title: 'Everything you would paste into an AI, in one place',
    body: 'Paste text or an image from your clipboard, take a screenshot, dictate a thought, or record your screen and voice. Eavesy saves each one as a capture on your Mac, so the context is ready when you are.',
    points: ['Clipboard text and images', 'Screenshots, screen recording, dictation', 'Open the launcher with a global hotkey'],
    flip: false,
    visual: 'capture',
  },
  {
    icon: Brain,
    eyebrow: 'Fast to paste',
    title: 'Clean Markdown, one copy away from your agent',
    body: 'Recordings and dictation become a transcript and a structured Markdown summary. Copy it into Claude, Cursor, ChatGPT, or any agent instead of re-typing the context from memory, or let an MCP-capable agent fetch it itself.',
    points: ['Copy into any AI agent', 'Summary, decisions, action items', 'Read-only MCP server for agents'],
    flip: true,
    visual: 'summary',
  },
  {
    icon: FolderTree,
    eyebrow: 'Local-first',
    title: 'Plain files on your disk, in formats every tool reads',
    body: 'The Mac app writes each capture to a normal folder as Markdown, JSON, and media. Point an agent at the folder, open it in Obsidian, or grep it. Dictation and recordings are sent to the cloud for transcription once you sign in; clipboard notes, images, and screenshots stay on your Mac. You can bring your own OpenRouter account for the AI work.',
    points: ['Markdown + JSON + media', 'Normal files on your Mac', 'Bring your own OpenRouter key'],
    flip: false,
    visual: 'files',
  },
];

export interface BentoItem {
  icon: LucideIcon;
  title: string;
  body: string;
  span?: boolean;
  highlight?: boolean;
}

export const BENTO: BentoItem[] = [
  { icon: Zap, title: 'Paste what you are looking at', body: 'Open the launcher with your global hotkey and press ⌘V to save the text or image on your clipboard as a capture you can find and copy again later.', span: true, highlight: true },
  { icon: Search, title: 'Screenshots', body: 'Grab the screen and keep it next to the rest of your context for a bug report or a coding agent.' },
  { icon: ListChecks, title: 'Dictation', body: 'Speak a rough thought and, once you are signed in, get clean text ready to paste where you are working.' },
  { icon: Languages, title: 'Recordings', body: 'Record your screen, system audio, and mic. Sign in to get a transcript and a Markdown summary when you stop.' },
  { icon: Lock, title: 'Sensitive material', body: 'Capture starts only when you start it, files stay on your disk, and you decide what gets shared.' },
  { icon: Cloud, title: 'A library your agents can read', body: 'Find a past capture, copy it, or connect a read-only MCP server so your agent can search it.', span: true },
];

export interface Step {
  n: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

export const STEPS: Step[] = [
  { n: '01', icon: Mic, title: 'Drop it in', body: 'Open the launcher with a hotkey, then paste your clipboard, take a screenshot, dictate, or start a recording.' },
  { n: '02', icon: Radio, title: 'Eavesy cleans it up', body: 'Audio becomes a transcript and a structured Markdown summary. Text and images are saved as they are.' },
  { n: '03', icon: FileText, title: 'Hand it to your agent', body: 'Copy the Markdown into any AI agent, point it at the folder, or let it read your library over MCP.' },
];

export interface CompareRow {
  label: string;
  them: string;
  us: string;
}

export const COMPARISON: CompareRow[] = [
  { label: 'Built for', them: 'Human meeting notes', us: 'Feeding context to your AI agent' },
  { label: 'What you can drop in', them: 'Call audio only', us: 'Clipboard text and images, screenshots, dictation, recordings' },
  { label: 'What you get', them: 'A summary in their app', us: 'Markdown you paste into any agent' },
  { label: 'Your data', them: 'Locked in their app', us: 'Markdown + JSON files on your disk' },
  { label: 'Joins your call', them: 'A bot everyone sees', us: 'Never. It captures on your Mac' },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  { q: 'What is Eavesy?', a: 'A local, AI-first assistant for your Mac. You drop things into it (clipboard text and images, screenshots, dictation, and recordings) and it saves them as clean Markdown context that is quick to paste into Claude, Cursor, ChatGPT, or any agent, or to reach over MCP.' },
  { q: 'How do I get the context into my AI agent?', a: 'Copy the Markdown for a capture and paste it into any agent. Recordings and dictation include a transcript and a structured summary. You can also point an agent at the capture folder on your disk, or connect the read-only MCP server so a compatible agent can search your library itself.' },
  { q: 'Can I drop in text, messages, or orders?', a: 'You can paste any text or image from your clipboard into the Mac app and it is saved as a note or image capture. A dedicated flow for forwarding messages and orders from other apps is not available yet.' },
  { q: 'Does it still record meetings?', a: 'Yes. The Mac app records your screen, system audio, and microphone with no bot joining the call, and the web app has a browser recorder. Recording is one of the inputs, not the whole product. Live captions are not available yet; transcripts arrive shortly after audio is processed. You remain responsible for following consent rules.' },
  { q: 'Do I have to create an account?', a: 'Pasting clipboard text or images and taking screenshots on your Mac works without one. Dictation and recordings need you to sign in (one click from the app) so they can be transcribed and summarized; signing in also adds search and the MCP server.' },
  { q: 'Where does my data live?', a: 'With the Mac app, each capture is a folder on your disk containing Markdown, JSON, and media files. Dictation and recordings are also uploaded to a private cloud copy for transcription, search, and recovery; clipboard notes, images, and screenshots are not uploaded. You can connect your own OpenRouter account to run the AI on your own credits.' },
  { q: 'Which platforms are supported?', a: 'The Mac app supports Apple Silicon Macs on macOS 13 or later (screenshots need macOS 14). The web app and browser recorder work in a modern browser. Other platforms are not available yet.' },
];

export interface FooterColumn {
  title: string;
  links: { label: string; href: string }[];
}

export const FOOTER_COLUMNS: FooterColumn[] = [
  { title: 'Product', links: [{ label: 'Features', href: '/features' }, { label: 'How it works', href: '/how-it-works' }, { label: 'Integrations', href: '/integrations' }, { label: 'Mac app', href: '/download/mac' }] },
  { title: 'Resources', links: [{ label: 'Docs', href: '/docs' }, { label: 'Blog', href: '/blog' }, { label: 'Changelog', href: '/changelog' }, { label: 'GitHub', href: 'https://github.com/williamrogersdev/eavesy' }] },
  { title: 'Company', links: [{ label: 'About', href: '/about' }, { label: 'Contact', href: '/contact' }, { label: 'Security', href: '/security' }] },
  { title: 'Legal', links: [{ label: 'Privacy', href: '/privacy' }, { label: 'Terms', href: '/terms' }] },
];
