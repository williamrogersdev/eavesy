export interface Recording {
  id: string;
  title: string;
  startedAt: number;
  durationSec: number;
  source: 'system' | 'mic' | 'both' | 'dictation' | 'upload' | 'screen' | 'screenshot' | 'note' | 'image';
  status: 'recording' | 'processing' | 'complete' | 'failed' | 'transcript_failed';
  summary?: string;
  transcript?: string;
  hasAudio: boolean;
  hasVideo?: boolean;
}
