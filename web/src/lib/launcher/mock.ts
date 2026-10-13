import type { Recording } from './types';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function mockRecordings(now: number): Recording[] {
  const rows: Omit<Recording, 'hasAudio'>[] = [
    {
      id: 'demo_1',
      title: 'Acme Corp — Q3 roadmap sync',
      startedAt: now - 2 * HOUR,
      durationSec: 2730,
      source: 'system',
      status: 'complete',
      summary:
        'Aligned on shipping the billing revamp before the design system migration. Priya owns the migration spike; ship date target is the last week of the quarter.',
      transcript:
        "Priya: Okay, so the big question this quarter is sequencing — do we do billing first or the design system migration?\nMarcus: Billing has the revenue impact, and the design system can slot in behind it without blocking anyone.\nPriya: Agreed. I'll take the migration spike so it's ready the moment billing lands.\nMarcus: Let's lock the billing ship date for the last week of the quarter and work backwards from there.",
    },
    {
      id: 'demo_2',
      title: '1:1 with Jordan',
      startedAt: now - DAY - 3 * HOUR,
      durationSec: 1495,
      source: 'mic',
      status: 'complete',
      summary:
        'Jordan is ready for more scope — wants to lead the onboarding rewrite. Flagged that the staging env is flaky and costing the team ~3h/week.',
      transcript:
        "Jordan: I think I'm ready to own something end to end — the onboarding rewrite feels like the right size.\nYou: Let's do it. I'll get you the design context this week.\nJordan: One thing — staging has been really flaky, it's eating maybe three hours a week across the team.\nYou: Noted, I'll raise it with infra on Thursday.",
    },
    {
      id: 'demo_screen',
      title: 'Product demo — onboarding walkthrough',
      startedAt: now - 5 * HOUR,
      durationSec: 412,
      source: 'screen',
      status: 'complete',
      summary:
        'Screen recording walking a new customer through workspace setup, importing their first meeting, and sharing a transcript. Loom-style — screen + voiceover.',
      transcript:
        "So once you're signed in, hit the record hotkey from anywhere — you'll see this panel. I'll start a screen recording now and walk through importing your first meeting. Notice the transcript builds live on the right as I talk.",
    },
    {
      id: 'demo_3',
      title: 'Dictation — blog intro draft',
      startedAt: now - DAY,
      durationSec: 92,
      source: 'dictation',
      status: 'complete',
      summary: 'Rough intro paragraph for the launch post.',
      transcript:
        "The fastest way to capture a meeting isn't to open an app and click record. It's to hit one key and start talking — everything else should get out of your way.",
    },
    {
      id: 'demo_4',
      title: 'Customer call — Northwind onboarding',
      startedAt: now - 3 * DAY,
      durationSec: 3320,
      source: 'both',
      status: 'complete',
      summary:
        'Northwind wants SSO before rollout to their 400 seats. Procurement needs a SOC 2 report. Champion is the VP of Ops; blocker is IT security review.',
      transcript:
        "VP Ops: We're excited, but IT won't green-light a rollout without SSO and a SOC 2 report.\nYou: SSO is in beta now — I can get you on the list this week. SOC 2 Type II is available under NDA.\nVP Ops: Perfect. If those two clear security, we're talking 400 seats.",
    },
    {
      id: 'demo_5',
      title: 'Standup — platform team',
      startedAt: now - 4 * DAY,
      durationSec: 640,
      source: 'system',
      status: 'complete',
      summary:
        'Queue consumer is deployed to staging. One blocker: R2 multipart uploads failing over 5GB — Sam investigating.',
      transcript:
        "Sam: Queue consumer is on staging and draining cleanly. The one blocker is R2 multipart — anything over 5 gigs fails the final part.\nLee: I hit that too. I think it's the part-size math.\nSam: I'll pair with you after standup.",
    },
  ];
  return rows.map((r) => ({
    ...r,
    hasAudio: r.source !== 'dictation',
    hasVideo: r.source === 'screen',
  }));
}
