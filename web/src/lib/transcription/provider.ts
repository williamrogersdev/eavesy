import type { TranscriptSegment } from './types';

export interface SegmentTranscription {
  text: string;
  segments: TranscriptSegment[];
  language?: string;
  durationSec?: number;
}

export interface SegmentTranscriber {
  transcribe(args: {
    audio: Uint8Array;
    language?: string;
    contextBlurb?: string | null;
    vadFilter?: boolean;
  }): Promise<SegmentTranscription>;
}
