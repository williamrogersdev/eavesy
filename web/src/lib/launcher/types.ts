export interface Recording {
  id: string;
  title: string;
  startedAt: number;
  durationSec: number;
  source: 'system' | 'mic' | 'both' | 'dictation' | 'upload' | 'screen' | 'screenshot' | 'note' | 'image';
  status: 'recording' | 'processing' | 'complete' | 'failed' | 'transcript_failed';
  summary?: string;
  transcript?: string;
  /** Metadata rows contain only a bounded transcript preview. */
  transcriptTruncated?: boolean;
  detailsLoaded?: boolean;
  revision?: number;
  hasAudio: boolean;
  hasVideo?: boolean;
}
