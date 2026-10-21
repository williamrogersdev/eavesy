import type { LucideIcon } from 'lucide-react';
import {
  Brain,
  ClipboardPaste,
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
    slug: 'walkthroughs', icon: Radio, eyebrow: 'Screen and voice', name: 'Walkthroughs',
    title: 'Record a walkthrough your AI can investigate',
    description: 'Capture screen video and narration on your Mac. Review the transcript, add visual evidence, and hand the context to your AI assistant.',
    intro: 'Use Video mode to show a bug, design, or product flow while explaining what you see. Eavesy saves the recording locally and processes signed-in audio into a transcript and brief. Share the text and the visual evidence your agent needs.',
    highlights: [
      { title: 'Screen, microphone, and computer audio', body: 'Video mode captures the walkthrough after you grant the required macOS permissions.' },
      { title: 'Keep the source files', body: 'The recording stays in a normal folder with available transcript, brief, and metadata files.' },
      { title: 'Choose the evidence to share', body: 'Add screenshots or a supported video attachment when your task needs visual inspection. A transcript alone does not describe every visible detail.' },
      { title: 'Clear processing boundaries', body: 'On-device captions can provide preliminary words. Sign in for the cloud transcript and brief. Version 0.5.4 does not automatically extract a visual frame timeline.' },
    ],
    related: ['bot-free-capture', 'transcription', 'files-you-own'],
  },
  {
    slug: 'quick-capture',
    icon: ClipboardPaste,
    eyebrow: 'Drop things in',
    name: 'Quick capture',
    title: 'Drop text, images, and screenshots into your context library',
    description:
      'In the Mac app, press ⌘V to save clipboard text or an image, or take a screenshot. Each one is stored as a Markdown or image file you can copy into any AI agent.',
    intro:
      'Not everything your AI needs is a recording. Open the Eavesy launcher with ⌘⇧Space and press ⌘V: text on your clipboard is saved as a Markdown note and an image is saved as a PNG, both in your capture history. Take a screenshot from the same window, or drop a file in. Everything lands in a normal folder on your disk, next to your recordings, and stays on your Mac.',
    highlights: [
      { title: 'Clipboard text and images', body: 'Press ⌘V in the launcher to save whatever you copied last, a message, an order, a snippet of code, or an image, as a capture.' },
      { title: 'Screenshots', body: 'Take a screenshot of your display from the launcher (macOS 14 or later). Eavesy’s own window is left out of the image.' },
      { title: 'Plain files', body: 'Text is stored as note.md and images as PNG files in a folder you can open, grep, or point an agent at.' },
      { title: 'Drop in files', body: 'Drop images, Markdown or text files, audio, or video onto the launcher to keep a copy with the rest of your context.' },
    ],
    faqs: [
      { q: 'Can I drop in a message or an order?', a: 'Copy it and press ⌘V in the Eavesy launcher. It is saved as a Markdown note. Capturing directly from other apps is not available yet.' },
    ],
    related: ['files-you-own', 'dictation', 'live-summary'],
  },
  {
    slug: 'bot-free-capture',
    icon: Radio,
    eyebrow: 'Eyes and ears',
    name: 'Talk, meetings and video',
    title: 'Record your voice, your calls, or your screen with no bot on the call',
    description:
      'Talk records your mic. Meeting records your mic and the audio your Mac plays. Video records your screen, its audio, and your mic. Nothing joins the call and no meeting link is needed.',
    intro:
      'Eavesy records from your Mac instead of joining your call. Pick the mode that fits: Talk for dictation and voice memos, Meeting for both sides of a call or a conversation in the room, and Video for walkthroughs and bug reports. You choose when it starts and stay in control of consent and sharing.',
    highlights: [
      { title: 'Three modes', body: 'Talk uses your mic only. Meeting adds the audio your Mac plays, without recording the screen. Video records your screen, its audio, and your mic.' },
      { title: 'No meeting bot', body: 'Nothing joins the participant list. Eavesy records from your Mac while you handle consent according to your organization and local requirements.' },
      { title: 'Works in person too', body: 'No meeting link required. Record a hallway conversation, a workshop, or a 1:1 over coffee the same way you record a Zoom call.' },
      { title: 'Shortcuts to start', body: 'Press ⌘⇧D to talk from anywhere, or ⌘⇧Space to open the launcher and start a meeting or video.' },
    ],
    faqs: [
      { q: 'Does anyone on the call know I’m recording?', a: 'Eavesy does not add a participant to the call. Tell participants when required and follow the consent laws in your jurisdiction and your organization’s policy.' },
      { q: 'Does it work for in-person meetings?', a: 'Yes. Meeting mode records your Mac’s microphone directly, so no meeting link is needed. It works in the room just as well as on a call.' },
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
      { title: 'Decisions & steps', body: 'Commitments, next steps, and the actions you took are pulled out and grouped for review against the original transcript.' },
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
    title: 'Live captions on your Mac, full transcripts in the cloud',
    description:
      'On-device live captions while you record, then a Whisper transcript in the cloud that replaces them. English by default, with other languages and automatic detection in Settings.',
    intro:
      'The Mac app writes live captions on your Mac as you speak, with no account needed. When you sign in, audio uploads in segments and Whisper produces a full transcript that replaces the captions. Meetings are labelled You and Them by track. Add custom words so names and jargon come out right.',
    highlights: [
      { title: 'Recoverable rolling segments', body: 'Long recordings upload in segments while you record, limiting how much a crash or network interruption can affect.' },
      { title: 'Your language, your words', body: 'English by default. Pick another language or automatic detection, and add up to 100 custom words, under Settings → Transcription.' },
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
    title: 'Find context in your completed recordings',
    description:
      'Semantic search across all your meetings. Find the moment a decision was made, even when you don’t remember the exact words used.',
    intro:
      'Your meetings become a searchable knowledge base. Eavesy indexes every transcript so you can ask for a topic in plain language and jump straight to the moment it came up — across completed, available account recordings. Retrieval and answer context can have limits; inspect source passages before relying on a result.',
    highlights: [
      { title: 'Meaning, not just keywords', body: 'Semantic search finds the right moment even when the words you search for aren’t the words that were said.' },
      { title: 'Across every meeting', body: 'Search can span completed recordings in your account. Processing state, indexing, and retrieval limits affect what is available.' },
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
      { title: 'Local source files + private processing', body: 'Files live on your Mac. When you sign in, a private cloud copy of your recordings powers transcription, search, sync, and recovery.' },
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
      { title: 'Clear deletion controls', body: 'Delete recordings or your account from the app. Cloud removal completes through the documented deletion process; local folders remain under your control.' },
    ],
    related: ['files-you-own', 'bot-free-capture'],
  },
  {
    slug: 'dictation',
    icon: Mic,
    eyebrow: 'Dictation',
    name: 'Dictation',
    title: 'Talk, and the words land where your cursor is',
    description:
      'Press ⌘⇧D, speak, and Eavesy pastes on-device text where your cursor is. No account needed. Signed in, a cleaned-up copy is kept in the cloud too.',
    intro:
      'Tap ⌘⇧D to start and again to stop, or hold it to talk. Eavesy turns your words into text on your Mac and pastes it into the app you’re using. When you’re signed in, the audio also gets a cloud transcript, and that copy is lightly cleaned up with filler removed and punctuation added.',
    highlights: [
      { title: 'On-device first', body: 'The text pasted on your Mac is made on your Mac, with or without an account.' },
      { title: 'Cleanup in the cloud copy', body: 'Filler words and false starts are removed only in the cloud copy, never in the text pasted on your Mac.' },
      { title: 'Tap or hold', body: 'Tap to toggle, or hold for push-to-talk. Set Talk to fn if you like.' },
    ],
    related: ['transcription', 'semantic-search'],
  },
];

export function getFeature(slug: string): FeaturePage | undefined {
  return FEATURE_PAGES.find((f) => f.slug === slug);
}

export const FEATURE_SLUGS = FEATURE_PAGES.map((f) => f.slug);
