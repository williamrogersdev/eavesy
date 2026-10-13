import { hasBothSides, speakerName } from '@/lib/transcription/two-track';
import { meetingFolderSlug } from '@/lib/utils';

export interface MeetingForExport {
  id: string;
  title: string;
  description: string;
  startedAt: number;
  durationSec?: number;
  platform?: string;
  participants?: string[];
  folder?: string;
  tags?: string[];
  audioLocalFilename?: string;
  audioCloudUrl?: string;
  syncStatus?: 'synced' | 'local-only' | 'uploading' | 'failed';
  lastSynced?: number;
  language?: string;
}

export interface SummaryForExport {
  tldr: string;
  decisions: { text: string }[];
  actionItems: { text: string; owner?: string; due?: string; completed: boolean }[];
  followUps: { text: string }[];
  openQuestions: { text: string }[];
  topics: string[];
  mentions: { entity: string; type: string }[];
}

export interface TranscriptSegmentForExport {
  startMs: number;
  speakerId?: string | null;
  text: string;
}

export function folderName(meeting: MeetingForExport): string {
  return meetingFolderSlug(meeting.title, new Date(meeting.startedAt));
}

export function renderSummaryMd(meeting: MeetingForExport, summary: SummaryForExport): string {
  const fm = renderFrontmatter({
    id: meeting.id,
    title: meeting.title,
    description: meeting.description,
    started_at: new Date(meeting.startedAt).toISOString(),
    duration_sec: meeting.durationSec ?? null,
    platform: meeting.platform ?? null,
    participants: meeting.participants ?? null,
    folder: meeting.folder ?? null,
    tags: meeting.tags ?? null,
    audio_local: meeting.audioLocalFilename ?? null,
    audio_cloud: meeting.audioCloudUrl ?? null,
    sync_status: meeting.syncStatus ?? null,
    last_synced: meeting.lastSynced ? new Date(meeting.lastSynced).toISOString() : null,
  });

  const lines: string[] = [fm, `# ${meeting.title}`, ''];

  lines.push('## TL;DR', summary.tldr || '_(none)_', '');

  if (summary.decisions.length) {
    lines.push('## Decisions');
    for (const d of summary.decisions) lines.push(`- ${d.text}`);
    lines.push('');
  }

  if (summary.actionItems.length) {
    lines.push('## Action items');
    for (const a of summary.actionItems) {
      const owner = a.owner ? `**${a.owner}**: ` : '';
      const due = a.due ? ` _(due: ${a.due})_` : '';
      const check = a.completed ? 'x' : ' ';
      lines.push(`- [${check}] ${owner}${a.text}${due}`);
    }
    lines.push('');
  }

  if (summary.followUps.length) {
    lines.push('## Follow-ups');
    for (const f of summary.followUps) lines.push(`- ${f.text}`);
    lines.push('');
  }

  if (summary.openQuestions.length) {
    lines.push('## Open questions');
    for (const q of summary.openQuestions) lines.push(`- ${q.text}`);
    lines.push('');
  }

  if (summary.topics.length) {
    lines.push('## Topics', summary.topics.join(', '), '');
  }

  if (summary.mentions.length) {
    lines.push('## Mentions');
    for (const m of summary.mentions) lines.push(`- ${m.entity} *(${m.type})*`);
    lines.push('');
  }

  return lines.join('\n');
}

export function renderTranscriptMd(
  meeting: MeetingForExport,
  segments: TranscriptSegmentForExport[],
  opts: { speakerNames?: Record<string, string>; chapters?: { startMs: number; title: string }[] } = {},
): string {
  const fm = renderFrontmatter({
    id: meeting.id,
    title: meeting.title,
    started_at: new Date(meeting.startedAt).toISOString(),
  });
  const body: string[] = [fm, `# Transcript — ${meeting.title}`, ''];
  if (opts.chapters?.length) {
    body.push('## Chapters', '');
    for (const chapter of opts.chapters) body.push(`- [${formatTimestamp(chapter.startMs)}] ${chapter.title}`);
    body.push('', '## Transcript', '');
  }
  const labelled = hasBothSides(segments.map((seg) => ({ speakerId: seg.speakerId ?? null })));
  for (const seg of segments) {
    const ts = formatTimestamp(seg.startMs);
    const speaker =
      labelled && seg.speakerId ? `**${speakerName(seg.speakerId, opts.speakerNames)}**: ` : '';
    body.push(`[${ts}] ${speaker}${seg.text}`);
  }
  return body.join('\n');
}

export function renderNotesMd(meeting: MeetingForExport, contentMd: string): string {
  const fm = renderFrontmatter({
    id: meeting.id,
    title: meeting.title,
    started_at: new Date(meeting.startedAt).toISOString(),
  });
  return `${fm}# Notes\n\n${contentMd || '_(empty)_'}\n`;
}

export function renderMeetingJson(payload: {
  meeting: MeetingForExport;
  summary?: SummaryForExport;
  segments?: TranscriptSegmentForExport[];
  notesMd?: string;
  summaryOverrideMd?: string | null;
  transcriptOverrideMd?: string | null;
}): string {
  return JSON.stringify(payload, null, 2);
}

function renderFrontmatter(obj: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlString(frontmatterScalar(item))}`);
    } else {
      lines.push(`${k}: ${yamlString(frontmatterScalar(v))}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function frontmatterScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function yamlString(s: string): string {
  if (/^[\w./:-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  return `${pad(m)}:${pad(s)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
