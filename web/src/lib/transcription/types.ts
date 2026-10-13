export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  speakerId?: string;
  text: string;
  confidence?: number;
  isFinal: boolean;
  noSpeechProb?: number;
  compressionRatio?: number;
}

export type TranscriptionEvent =
  | { type: 'partial'; segment: TranscriptSegment }
  | { type: 'final'; segment: TranscriptSegment }
  | { type: 'error'; error: Error }
  | { type: 'closed' };

export type TranscriptionListener = (event: TranscriptionEvent) => void;

export interface TranscriptionSession {
  sendChunk(chunk: ArrayBuffer | Blob): void;
  finish(): Promise<void>;
  abort(): void;
}

export interface TranscriptionEngine {
  startSession(opts: {
    sampleRate: number;
    language: string;
    diarize: boolean;
    listener: TranscriptionListener;
  }): Promise<TranscriptionSession>;
}
