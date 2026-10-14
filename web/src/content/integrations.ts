export type IntegrationCategory = 'Video calls' | 'Notes & knowledge' | 'In person';

export interface Integration {
  slug: string;
  name: string;
  category: IntegrationCategory;
  tagline: string;
  description: string;
  steps: string[];
  faqs?: { q: string; a: string }[];
}

export const INTEGRATIONS: Integration[] = [
  {
    slug: 'zoom',
    name: 'Zoom',
    category: 'Video calls',
    tagline: 'Turn Zoom calls into an AI-ready brief — no bot',
    description:
      'Record and transcribe any Zoom call straight from your Mac, then get a Markdown brief you can paste into your AI. Because Eavesy captures system audio, there’s no bot in the participant list and nothing to enable in your Zoom account.',
    steps: [
      'Start your Zoom call as usual.',
      'Hit record in Eavesy — it captures Zoom’s audio plus your mic.',
      'On long Mac sessions, processed transcript and notes arrive in batches as sealed segments upload.',
      'Stop, and your Zoom call is saved as a transcript, brief, and audio file — ready to paste into an agent.',
    ],
    faqs: [
      { q: 'Do I need Zoom admin rights?', a: 'No. Eavesy records the audio your Mac plays, so it works on any Zoom plan with no account settings to change.' },
      { q: 'Will other people see a recording bot?', a: 'No. Nothing joins your Zoom call — Eavesy captures audio locally on your machine.' },
    ],
  },
  {
    slug: 'google-meet',
    name: 'Google Meet',
    category: 'Video calls',
    tagline: 'Brief your AI from Google Meet, no extension',
    description:
      'Capture Google Meet calls by recording your Mac’s screen and audio — no Chrome extension, no bot, no Workspace admin approval. Get a clean Markdown brief to hand to your AI.',
    steps: [
      'Join your Google Meet call in the browser.',
      'Press record in Eavesy to capture Meet audio and your mic.',
      'On long Mac sessions, processed transcript and notes arrive in batches as sealed segments upload.',
      'Stop to save a clean brief and full transcript you can paste into any agent.',
    ],
    faqs: [
      { q: 'Does this need a browser extension?', a: 'No. Eavesy records system audio at the OS level, so it works with Google Meet in any browser without an extension.' },
    ],
  },
  {
    slug: 'microsoft-teams',
    name: 'Microsoft Teams',
    category: 'Video calls',
    tagline: 'Turn Teams meetings into context for your AI',
    description:
      'Record and brief Teams meetings without IT having to enable anything. Eavesy captures the call on your device and keeps the files on your disk, ready to paste into any agent.',
    steps: [
      'Start or join your Teams meeting.',
      'Hit record in Eavesy to capture Teams audio and your mic.',
      'Long Mac sessions upload and process sealed segments in batches.',
      'Stop to get a transcript, brief, and audio you control.',
    ],
  },
  {
    slug: 'webex',
    name: 'Webex',
    category: 'Video calls',
    tagline: 'Briefs and transcripts for Webex calls',
    description:
      'Capture Webex calls the same simple way — record your Mac’s screen and audio, get a transcript and an AI-ready brief, with no bot joining the session.',
    steps: [
      'Join your Webex meeting.',
      'Press record in Eavesy.',
      'Let Eavesy upload and process sealed segments during a long session.',
      'Stop to save the session to your disk.',
    ],
  },
  {
    slug: 'slack',
    name: 'Slack huddles',
    category: 'Video calls',
    tagline: 'Capture Slack huddles as AI-ready briefs',
    description:
      'Turn quick Slack huddles into transcripts and briefs you can search later or hand to your AI — recorded locally, with no bot in the huddle.',
    steps: [
      'Start or join a Slack huddle.',
      'Hit record in Eavesy to capture the audio.',
      'Let Eavesy upload and process sealed segments during a long session.',
      'Stop to save the huddle as a file you own.',
    ],
  },
  {
    slug: 'obsidian',
    name: 'Obsidian',
    category: 'Notes & knowledge',
    tagline: 'Drop every session into your Obsidian vault',
    description:
      'Eavesy writes each session as a Markdown folder on your disk — point it at your Obsidian vault and your captures become linkable, searchable notes your agents can read too.',
    steps: [
      'Set Eavesy’s save location to your Obsidian vault folder.',
      'Record a session as usual.',
      'The brief, transcript, and metadata are written as Markdown.',
      'Open Obsidian to find the session waiting as a note you can link and tag.',
    ],
    faqs: [
      { q: 'What format are the notes in?', a: 'Plain Markdown plus JSON metadata and the audio file — fully compatible with Obsidian and any other Markdown tool.' },
    ],
  },
  {
    slug: 'notion',
    name: 'Notion',
    category: 'Notes & knowledge',
    tagline: 'Bring session briefs into Notion',
    description:
      'Export any session’s Markdown brief and paste or import it into Notion, so your context lives next to your docs and project pages.',
    steps: [
      'Record and brief your session in Eavesy.',
      'Copy the Markdown brief or export the session.',
      'Paste it into a Notion page — formatting carries over.',
      'Link it from your project or meeting database.',
    ],
  },
  {
    slug: 'apple-notes',
    name: 'Apple Notes',
    category: 'Notes & knowledge',
    tagline: 'Send briefs to Apple Notes',
    description:
      'Keep things simple — copy a clean session brief straight into Apple Notes, formatted and ready to read.',
    steps: [
      'Finish recording in Eavesy.',
      'Copy the brief.',
      'Paste it into a new Apple Note.',
    ],
  },
  {
    slug: 'in-person',
    name: 'In-person meetings',
    category: 'In person',
    tagline: 'Capture real-world conversations, no link needed',
    description:
      'Eavesy doesn’t need a meeting link. Record a 1:1 over coffee, a workshop, or a hallway chat using your Mac’s microphone, and get the same transcript and AI-ready brief.',
    steps: [
      'Open Eavesy and hit record.',
      'Your microphone captures the room.',
      'Long Mac sessions upload and process sealed segments in batches.',
      'Stop to save the conversation as a file you own.',
    ],
  },
];

export function getIntegration(slug: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

export const INTEGRATION_SLUGS = INTEGRATIONS.map((i) => i.slug);

export const INTEGRATION_CATEGORIES: IntegrationCategory[] = [
  'Video calls',
  'Notes & knowledge',
  'In person',
];
