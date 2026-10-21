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
  { label: 'Guides', href: '/guides' },
  { label: 'Templates', href: '/templates' },
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
    body: 'Signed-in recordings receive a cloud transcript and Markdown summary. Dictation produces text to paste; its signed-in cloud copy can be cleaned up. Copy it into Claude, Cursor, ChatGPT, or any agent instead of re-typing the context from memory, or let an MCP-capable agent fetch it itself.',
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
  { icon: ListChecks, title: 'Dictation', body: 'Speak into the app you are using. On-device dictation works without an account when recognition is available; pasting needs Accessibility permission.' },
  { icon: Languages, title: 'Recordings', body: 'Record your screen, system audio, and mic. Sign in to get a transcript and a Markdown summary when you stop.' },
  { icon: Lock, title: 'Sensitive material', body: 'Capture starts only when you start it, files stay on your disk, and you decide what gets shared.' },
  { icon: Cloud, title: 'A library your agents can read', body: 'Read local captures as files, or connect the hosted MCP server to search synced recordings and dictations. Local screenshots and notes are not uploaded to MCP.', span: true },
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
  { n: '03', icon: FileText, title: 'Hand it to your agent', body: 'Copy the Markdown into any AI agent, point it at the folder, or let it read synced recordings over hosted MCP.' },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQS: Faq[] = [
  { q: 'What is Eavesy?', a: 'A local, AI-first assistant for your Mac. You drop things into it (clipboard text and images, screenshots, dictation, and recordings) and it saves them as local files and readable text that is quick to paste into Claude, Cursor, ChatGPT, or any agent, with hosted MCP for synced recordings and dictations.' },
  { q: 'How do I get the context into my AI agent?', a: 'Copy the Markdown for a capture and paste it into any agent. Signed-in recordings can include a transcript and summary; dictation supplies text to paste. You can also point an agent at the capture folder on your disk, or connect the read-only MCP server so a compatible agent can search your library itself.' },
  { q: 'Can I drop in text, messages, or orders?', a: 'You can paste any text or image from your clipboard into the Mac app and it is saved as a note or image capture. A dedicated flow for forwarding messages and orders from other apps is not available yet.' },
  { q: 'Does it still record meetings?', a: 'Yes. The Mac app records your screen, system audio, and microphone with no bot joining the call, and the web app has a browser recorder. Recording is one of the inputs, not the whole product. On-device live captions are available with Speech Recognition permission. Signed-in recordings also receive cloud transcripts and summaries after processing. You remain responsible for following consent rules.' },
  { q: 'Do I have to create an account?', a: 'Pasting clipboard text or images and taking screenshots on your Mac works without one. On-device dictation, captions, and local recording work without an account when the required permissions and speech recognition are available. Sign in for cloud transcription, summaries, and hosted search and MCP access to synced recordings.' },
  { q: 'Where does my data live?', a: 'With the Mac app, each capture is a folder on your disk containing Markdown, JSON, and media files. Dictation and recordings are also uploaded to a private cloud copy for transcription, search, and recovery; clipboard notes, images, and screenshots are not uploaded. You can connect your own OpenRouter account to run the AI on your own credits.' },
  { q: 'Which platforms are supported?', a: 'The Mac app supports Apple Silicon Macs on macOS 13 or later (screenshots need macOS 14). The web app and browser recorder work in a modern browser. Other platforms are not available yet.' },
];

export interface FooterColumn {
  title: string;
  links: { label: string; href: string }[];
}

export const FOOTER_COLUMNS: FooterColumn[] = [
  { title: 'Product', links: [{ label: 'Features', href: '/features' }, { label: 'How it works', href: '/how-it-works' }, { label: 'Integrations', href: '/integrations' }, { label: 'Mac app', href: '/download/mac' }] },
  { title: 'Resources', links: [{ label: 'Guides', href: '/guides' }, { label: 'Templates', href: '/templates' }, { label: 'Examples', href: '/examples' },{ label: 'Docs', href: '/docs' }, { label: 'Blog', href: '/blog' }, { label: 'Changelog', href: '/changelog' }, { label: 'GitHub', href: 'https://github.com/williamrogersdev/eavesy' }] },
  { title: 'Company', links: [{ label: 'About', href: '/about' }, { label: 'Contact', href: '/contact' }, { label: 'Security', href: '/security' }] },
  { title: 'Legal', links: [{ label: 'Privacy', href: '/privacy' }, { label: 'Terms', href: '/terms' }] },
];
