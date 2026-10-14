import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  FileText,
  FolderTree,
  Lock,
  Mic,
  Radio,
  Search,
  Sparkles,
} from 'lucide-react';

export interface FeatureHighlight {
  title: string;
  body: string;
}

export interface FeaturePage {
  slug: string;
  icon: LucideIcon;
  eyebrow: string;
  name: string;
  title: string;
  description: string;
  intro: string;
  highlights: FeatureHighlight[];
  faqs?: { q: string; a: string }[];
  related?: string[];
  availability?: 'coming-soon';
}

export const FEATURE_PAGES: FeaturePage[] = [
  {
    slug: 'bot-free-capture',
    icon: Radio,
    eyebrow: 'Eyes and ears',
    name: 'Screen + voice capture',
    title: 'Capture your screen and voice — no bot on the call',
    description:
      'Eavesy records your screen, system audio, and mic straight from your Mac—what you see and what is said. No bot joins the call and no meeting link is required.',
    intro:
      'Most meeting recorders join the call as another participant and ask for calendar access. Eavesy takes a different path: it captures your screen, the audio your computer is playing, and your microphone. That same capture model works for calls, walkthroughs, bug reproductions, and in-person conversations. You choose when it starts and remain in control of consent and sharing.',
    highlights: [
      { title: 'Screen, system, and mic', body: 'It captures the window you’re walking through, every remote voice via system audio, and your mic — mixed into one clean session.' },
      { title: 'No meeting bot', body: 'Nothing joins the participant list. Eavesy records from your Mac while you handle consent according to your organization and local requirements.' },
      { title: 'Works in person too', body: 'No meeting link required. Record a hallway conversation, a workshop, or a 1:1 over coffee the same way you record a Zoom call.' },
      { title: 'Hotkey to start', body: 'Launch a capture from anywhere with a global shortcut — no need to switch apps or set anything up first.' },
    ],
    faqs: [
      { q: 'Does anyone on the call know I’m recording?', a: 'Eavesy does not add a participant to the call. Tell participants when required and follow the consent laws in your jurisdiction and your organization’s policy.' },
      { q: 'Does it work for in-person meetings?', a: 'Yes. Because it captures your Mac’s screen, audio, and microphone directly, no meeting link is needed — it records in-person conversations just as well as video calls.' },
    ],
    related: ['live-summary', 'transcription', 'privacy'],
  },
  {
    slug: 'live-summary',
    icon: Brain,
    eyebrow: 'AI-ready brief',
    name: 'AI-ready brief',
    title: 'A brief your AI agent can actually use',
    description:
      'Stop recording and get a clean Markdown brief — TL;DR, key decisions, the steps you took, and the full transcript. Copy it into Claude, Cursor, or ChatGPT in one click.',
    intro:
      'Long Mac recordings are processed in recoverable rolling segments, and the completed session is finalized after you stop: a polished title, a TL;DR, the decisions and steps, all sitting on top of the complete transcript. It’s structured as Markdown so you can paste it straight into an AI agent — no reformatting, no re-explaining what it missed.',
    highlights: [
      { title: 'Built to paste into agents', body: 'Clean Markdown with clear sections — copy the whole brief into Claude, Cursor, or ChatGPT as structured context.' },
      { title: 'Decisions & steps', body: 'Commitments, next steps, and the actions you took are pulled out and grouped so nothing slips through the cracks.' },
      { title: 'Shape every brief', body: 'Edit the Markdown directly, re-run a session with built-in coding, research, customer, and meeting formats, or create your own reusable template.' },
      { title: 'The full transcript, always', body: 'The brief stays attached to the complete, copyable transcript, so you retain the source material.' },
    ],
    faqs: [
      { q: 'Can I change how the brief is structured?', a: 'Yes. Edit a completed brief directly, regenerate it with a built-in format, or create a reusable custom template in Settings.' },
    ],
    related: ['transcription', 'templates', 'bot-free-capture'],
  },
  {
    slug: 'transcription',
    icon: FileText,
    eyebrow: 'Accurate transcription',
    name: 'Transcription',
    title: 'Durable transcripts in dozens of languages',
    description:
      'Whisper transcription with punctuation and multi-language support. Mac capture processes sealed rolling segments; browser recordings process after you stop.',
    intro:
      'Eavesy uses multilingual Whisper transcription. The Mac app seals recoverable audio segments during long recordings and processes each segment as it uploads; short browser recordings upload and process when you finish. The result is readable, searchable text without pretending batch transcription is an instant live caption feed.',
    highlights: [
      { title: 'Recoverable rolling segments', body: 'Long Mac sessions are sealed to disk in segments and processed during capture, limiting how much work a crash or network interruption can affect.' },
      { title: 'Multi-language', body: 'Transcribes dozens of languages automatically, with no setup or language picker required.' },
      { title: 'Portable output', body: 'Copy or export the transcript as Markdown; Mac sessions also keep the source files in a normal folder.' },
      { title: 'Always included', body: 'You always get the complete transcript, never just a summary.' },
    ],
    related: ['live-summary', 'semantic-search', 'files-you-own'],
  },
  {
    slug: 'semantic-search',
    icon: Search,
    eyebrow: 'Search everything',
    name: 'Semantic search',
    title: 'Search every word you’ve ever recorded',
    description:
      'Semantic search across all your meetings. Find the moment a decision was made, even when you don’t remember the exact words used.',
    intro:
      'Your meetings become a searchable knowledge base. Eavesy indexes every transcript so you can ask for a topic in plain language and jump straight to the moment it came up — across every conversation you’ve recorded.',
    highlights: [
      { title: 'Meaning, not just keywords', body: 'Semantic search finds the right moment even when the words you search for aren’t the words that were said.' },
      { title: 'Across every meeting', body: 'Search spans your entire history, not just one recording, so past context is always a query away.' },
      { title: 'Open the matching session', body: 'Results show a relevant excerpt and link back to the recording where that context was found.' },
    ],
    related: ['transcription', 'live-summary', 'files-you-own'],
  },
  {
    slug: 'templates',
    icon: Sparkles,
    eyebrow: 'Custom templates',
    name: 'Custom templates',
    title: 'Shape each brief for the work ahead',
    description:
      'Choose a built-in format or define reusable instructions, then regenerate a completed recording without changing its source transcript.',
    intro:
      'A standup, a sales call, and a coding session need different output. Eavesy includes focused formats for meetings, coding, research, and customer conversations, plus reusable custom instructions you manage in Settings.',
    highlights: [
      { title: 'Built for each session type', body: 'Built-in formats cover meetings, research, customer conversations, and coding-agent handoffs.' },
      { title: 'Re-run without losing the source', body: 'Regeneration replaces the generated brief while preserving the source transcript.' },
      { title: 'Consistent output', body: 'Reusable custom instructions keep repeated session types easier to compare and scan.' },
    ],
    related: ['live-summary', 'transcription', 'semantic-search'],
  },
  {
    slug: 'files-you-own',
    icon: FolderTree,
    eyebrow: 'You own the files',
    name: 'Files you own',
    title: 'Every session is a folder on your disk',
    description:
      'Markdown, JSON, and audio written to a real folder you control. Point an agent at it, open it in Obsidian, grep it from the terminal. Your context is never locked in.',
    intro:
      'With the Mac app, each session is saved as a real folder on your disk: a Markdown brief, the full transcript, the audio, and JSON metadata. It’s your context in open formats — portable, greppable, feed-it-to-any-agent, and yours to keep even if you stop using Eavesy.',
    highlights: [
      { title: 'Open formats', body: 'Markdown + JSON + audio, structured in a predictable folder layout you can read with any tool.' },
      { title: 'Local source files + private processing', body: 'Files live on your Mac while a private cloud copy powers transcription, search, sync, and recovery.' },
      { title: 'Fits your workflow', body: 'Drop the folder into an Obsidian vault, back it up with Dropbox, or pipe it through your own scripts.' },
      { title: 'Portable by design', body: 'Download an individual meeting bundle from its detail page; Mac sessions also remain as normal local files.' },
    ],
    related: ['privacy', 'transcription', 'semantic-search'],
  },
  {
    slug: 'privacy',
    icon: Lock,
    eyebrow: 'Private by default',
    name: 'Privacy',
    title: 'Private by default, with clear provider boundaries',
    description:
      'Local source files, encrypted cloud processing, documented provider policies, and clear export and deletion controls.',
    intro:
      'Your conversations are sensitive. The Mac app keeps normal source files on your disk, the cloud copy is protected in transit and at rest, and Eavesy documents which providers process each artifact.',
    highlights: [
      { title: 'Platform providers do not train on content', body: 'Cloudflare Workers AI and Anthropic’s commercial API state that customer content is not used for model training unless the customer explicitly opts in.' },
      { title: 'Encrypted in transit and at rest', body: 'TLS protects data in transit; Cloudflare-managed encryption protects object storage and database data at rest.' },
      { title: 'Capture is explicit', body: 'Recording begins only after you start it and grant the required microphone or screen permissions.' },
      { title: 'Clear deletion controls', body: 'Delete any recording, or your whole account, from the app; cloud copies are permanently removed. Local folders remain yours.' },
    ],
    related: ['files-you-own', 'bot-free-capture'],
  },
  {
    slug: 'dictation',
    icon: Mic,
    eyebrow: 'Dictation',
    name: 'Dictation',
    title: 'Turn speech into clean text, anywhere',
    description:
      'Dictate notes and have them cleaned up automatically — filler words removed, punctuation added — ready to paste wherever you’re working.',
    intro:
      'Beyond meetings, Eavesy turns quick spoken thoughts into tidy text. Dictate a note and it’s transcribed and lightly cleaned — filler removed, sentences punctuated — so it’s ready to drop into a doc, an email, or a task.',
    highlights: [
      { title: 'Cleaned automatically', body: 'Filler words and false starts are removed and punctuation added, so you get usable text, not a raw stream.' },
      { title: 'History you can search', body: 'Every dictation is saved and searchable alongside your meetings.' },
      { title: 'Fast and frictionless', body: 'Start with a hotkey, speak, and paste — no app switching required.' },
    ],
    related: ['transcription', 'semantic-search'],
  },
];

export function getFeature(slug: string): FeaturePage | undefined {
  return FEATURE_PAGES.find((f) => f.slug === slug);
}

export const FEATURE_SLUGS = FEATURE_PAGES.map((f) => f.slug);
