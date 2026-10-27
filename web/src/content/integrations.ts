export type IntegrationCategory = 'AI assistants' | 'Video calls' | 'Notes & knowledge' | 'In person';

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
    slug: 'claude-code', name: 'Claude Code', category: 'AI assistants',
    tagline: 'Give Claude Code context from your Mac',
    description: 'Read Eavesy transcripts and briefs as local files, attach visual evidence, or connect Claude Code to synced recordings over hosted MCP.',
    steps: ['Capture the conversation or walkthrough in Eavesy and review its transcript.', 'Give Claude Code the actual local recording folder, with permission to read the relevant files.', 'For a visual task, provide the screenshot separately and ask the agent to inspect it.', 'For synced account recordings, add the hosted MCP server and authenticate before asking a focused question.'],
    faqs: [{ q: 'Is the hosted server a way to read screenshots on my Mac?', a: 'No. Hosted MCP reads supported synced account content. A local coding agent needs file access to inspect local screenshots and videos.' }],
  },
  {
    slug: 'cursor', name: 'Cursor', category: 'AI assistants',
    tagline: 'Bring screenshots, dictation, and recording context into Cursor',
    description: 'Paste reviewed text into Cursor, supply screenshots for visual tasks, and connect supported account recordings over hosted MCP.',
    steps: ['Open the project and the Cursor input where you want to work.', 'Use Eavesy Talk to dictate, or copy a completed brief and paste it into the input.', 'Attach the relevant screenshot when the task depends on visible state.', 'Ask the agent to name the evidence it inspected before investigating the issue.'],
    faqs: [{ q: 'Does Eavesy automatically send my whole capture library to Cursor?', a: 'No. You choose what to paste or attach. A hosted MCP connection requires separate authorization and covers synced recordings, not local screenshots and notes.' }],
  },
  {
    slug: 'zoom',
    name: 'Zoom',
    category: 'Video calls',
    tagline: 'Turn Zoom calls into an AI-ready brief — no bot',
    description:
      'Use Meeting mode to capture your microphone and the sound Zoom plays on your Mac. Sign in for cloud transcripts and Markdown briefs. Follow your organization’s recording requirements.',
    steps: [
      'Start your Zoom call as usual.',
      'Hit record in Eavesy — it captures Zoom’s audio plus your mic.',
      'On long Mac sessions, processed transcript and notes arrive in batches as sealed segments upload.',
      'Stop, and your Zoom call is saved as a transcript, brief, and audio file — ready to paste into an agent.',
    ],
    faqs: [
      { q: 'Do I need Zoom admin rights?', a: 'Eavesy captures Mac audio rather than using Zoom’s cloud recording. macOS permissions, device policy, and participant consent still apply.' },
      { q: 'Will other people see a recording bot?', a: 'No. Nothing joins your Zoom call — Eavesy captures audio locally on your machine.' },
    ],
  },
  {
    slug: 'google-meet',
    name: 'Google Meet',
    category: 'Video calls',
    tagline: 'Brief your AI from Google Meet, no extension',
    description:
      'Capture Google Meet audio with Meeting mode on your Mac, then use a reviewed transcript or brief as context for your AI. No Eavesy browser extension or meeting participant bot is required; device and organization policies still apply.',
    steps: [
      'Join your Google Meet call in the browser.',
      'Press record in Eavesy to capture Meet audio and your mic.',
      'On long Mac sessions, processed transcript and notes arrive in batches as sealed segments upload.',
      'Stop to save a clean brief and full transcript you can paste into any agent.',
    ],
    faqs: [
      { q: 'Does this need a browser extension?', a: 'No. Eavesy records system audio at the OS level, so it works with Google Meet in any browser without an extension.' },
      { q: 'Can Eavesy join a Meet call for me?', a: 'Yes, if you want it to. When you can’t record from your Mac, send the Eavesy Notetaker from the web app. It joins as a visible participant, and the transcript fills in during the call.' },
    ],
  },
  {
    slug: 'microsoft-teams',
    name: 'Microsoft Teams',
    category: 'Video calls',
    tagline: 'Turn Teams meetings into context for your AI',
    description:
      'Capture Teams audio from your Mac with Meeting mode. The app needs macOS permissions, and your organization’s recording policy still applies. Signed-in audio processing produces a transcript and brief.',
    steps: [
      'Start or join your Teams meeting.',
      'Hit record in Eavesy to capture Teams audio and your mic.',
      'Long Mac sessions upload and process sealed segments in batches.',
      'Stop to get a transcript, brief, and audio you control.',
    ],
    faqs: [
      { q: 'Can Eavesy join a Teams meeting for me?', a: 'Yes, if you want it to. When you can’t record from your Mac, send the Eavesy Notetaker from the web app. It joins as a guest under a visible name, so the meeting has to allow guests.' },
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
    tagline: 'Keep recording notes in your Obsidian vault',
    description:
      'Copy a completed Eavesy brief into an Obsidian note, or place the recording files in a vault. Markdown files are compatible; this is a file workflow, not a native sync plugin.',
    steps: [
      'Start with a copy: open a completed recording folder and inspect summary.md and transcript.md.',
      'Copy the brief into a new Obsidian note, or copy the source folder into the vault.',
      'Keep JSON metadata and audio as separate files; add your own YAML frontmatter if needed.',
      'Link the note to your project and confirm any attachment references still open.',
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
      'Keep things simple — copy a clean session brief straight into Apple Notes, as text you can review and format.',
    steps: [
      'Finish recording in Eavesy.',
      'Copy the brief.',
      'Paste the text into a new Apple Note and review its formatting.',
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
  'AI assistants',
  'Video calls',
  'Notes & knowledge',
  'In person',
];
