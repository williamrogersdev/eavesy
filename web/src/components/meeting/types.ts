import { type Chapter, type TranscriptLine } from './transcript-player';

export type Segment = TranscriptLine;
interface ActionItem {
  text: string;
  owner?: string;
  due?: string;
  completed?: boolean;
}
interface Summary {
  tldr: string;
  decisions: { text: string }[];
  actionItems: ActionItem[];
  openQuestions: { text: string }[];
  chapters?: Chapter[];
}
export interface MeetingMeta {
  id: string;
  title: string;
  description?: string | null;
  startedAt: number;
  durationSec?: number | null;
  platform?: string | null;
  source?: string | null;
  deviceName?: string | null;
  status: string;
  statusError?: string | null;
  audioR2Key?: string | null;
  speakerNamesJson?: string | null;
  summaryOverrideMd?: string | null;
  transcriptOverrideMd?: string | null;
  agentTranscriptMd?: string | null;
  transcriptKind?: 'solo' | 'conversation' | null;
  folderId?: string | null;
}
export interface MeetingData {
  meeting: MeetingMeta;
  summary: Summary | null;
  segments: Segment[];
  notes: { contentMd: string } | null;
  /** Snapshots of shared screens and screenshots; absent from older servers. */
  attachments?: MeetingAttachment[];
  /** Where the live transcript stream resumes from; absent from older servers. */
  transcriptCursor?: number;
}

export interface MeetingAttachment {
  id: string;
  kind: 'snapshot' | 'screenshot';
  /** From the start of the recording, like a transcript line's `startMs`. */
  offsetMs: number;
  url: string;
  width: number | null;
  height: number | null;
  caption: string | null;
}
