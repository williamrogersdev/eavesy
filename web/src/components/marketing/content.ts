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
  'Zoom', 'Google Meet', 'Microsoft Teams', 'Webex', 'Slack huddles',
  'Obsidian', 'Notion', 'Apple Notes', 'In-person',
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
    eyebrow: 'Eyes and ears',
    title: 'Capture the whole workflow',
    body: 'Eavesy records the screen you are walking through, system audio, and your microphone. Use it for product demos, bug reproductions, calls, interviews, or in-person conversations—without adding a bot to the participant list.',
    points: ['Screen + system audio + mic', 'No meeting bot', 'You control when capture starts'],
    flip: false,
    visual: 'capture',
  },
  {
    icon: Brain,
    eyebrow: 'AI-ready brief',
    title: 'Get one clear, portable result',
    body: 'When you stop, Eavesy creates a structured Markdown brief with the goal, what happened, decisions, next steps, and the transcript. Copy it into any agent instead of rewriting the context from memory.',
    points: ['Copy into any AI agent', 'Summary + decisions + steps', 'Full transcript stays attached'],
    flip: true,
    visual: 'summary',
  },
  {
    icon: FolderTree,
    eyebrow: 'Context you own',
    title: 'Keep the source files and control',
    body: 'The Mac app writes every session to a normal folder with Markdown and audio. Use the files directly, index them in your own tools, or keep a private cloud copy for processing, search, and recovery.',
    points: ['Summary + transcript + audio', 'Normal files on your Mac', 'Private cloud sync is explicit'],
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
  { icon: Zap, title: 'Workflow walkthroughs', body: 'Explain a setup, design, or code path while the screen supplies the missing visual context.', span: true, highlight: true },
  { icon: Search, title: 'Bug reproductions', body: 'Capture the exact clicks, state, and explanation an engineer or coding agent needs.' },
  { icon: Languages, title: 'Meetings & interviews', body: 'Turn system audio and your mic into decisions, next steps, and a searchable transcript.' },
  { icon: Lock, title: 'Sensitive conversations', body: 'Start capture deliberately, keep local source files, and stay in control of what gets shared.' },
  { icon: ListChecks, title: 'Quick dictation', body: 'Speak a rough thought and get clean text ready to paste where you are working.' },
  { icon: Cloud, title: 'Reusable context library', body: 'Find a past session, copy the brief, or connect a read-only AI assistant.', span: true },
];

export interface Step {
  n: string;
  icon: LucideIcon;
  title: string;
  body: string;
}

export const STEPS: Step[] = [
  { n: '01', icon: Mic, title: 'Choose what to capture', body: 'Press your Mac hotkey, then choose voice, system audio, screen, or a quick capture.' },
  { n: '02', icon: Radio, title: 'Talk through the work', body: 'Eavesy records recoverable segments while you explain what matters and move through the workflow.' },
  { n: '03', icon: FileText, title: 'Use the finished brief', body: 'Copy structured Markdown into any AI agent, export the source files, or find the session later.' },
];

export interface CompareRow {
  label: string;
  them: string;
  us: string;
}

export const COMPARISON: CompareRow[] = [
  { label: 'Built for', them: 'Human meeting notes', us: 'Briefing your AI agent' },
  { label: 'Captures your screen', them: 'No — audio only', us: 'Yes — screen + voice' },
  { label: 'What you get', them: 'A summary in their app', us: 'Markdown you paste into any agent' },
  { label: 'Your context data', them: 'Locked in their app', us: 'Local files plus a private cloud copy' },
  { label: 'Joins your call', them: 'A bot everyone sees', us: 'Captures directly on your Mac' },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  { q: 'How do I get the context into my AI agent?', a: 'When you stop recording, Eavesy gives you a clean Markdown brief — TL;DR, key points, the steps you took, and the full transcript. Copy it with one click and paste it into Claude, Cursor, ChatGPT, or any agent. With the Mac app it’s also saved as a file you can point an agent straight at.' },
  { q: 'Does it record my screen?', a: 'The Mac app captures your screen alongside system audio and your mic, so the brief reflects what you saw and did, not just what was said.' },
  { q: 'Does it join my meetings like a bot?', a: 'No. Eavesy captures from your Mac, so it never appears in the participant list. You remain responsible for following applicable consent rules and telling people when a conversation is being recorded.' },
  { q: 'Do I have to create an account?', a: 'You can record on your Mac straight away. Signing in, which takes one click from the app, adds transcription, briefs, search, and recovery.' },
  { q: 'Where does my data live?', a: 'With the Mac app, every session is written to a folder on your disk with M4A audio, summary, transcript, notes, and a meeting manifest. A private cloud copy powers transcription, search, and recovery.' },
  { q: 'Which platforms are supported?', a: 'The initial native release supports Apple Silicon Macs on macOS 13 or later. Intel Mac, iOS, and Windows support are on the roadmap.' },
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
