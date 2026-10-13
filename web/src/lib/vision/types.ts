export type VisionMediaType = 'image/png' | 'image/jpeg' | 'image/webp';

export interface VisualTextResult {
  text: string;
  model: string;
  empty: boolean;
}

export interface VisionEngine {
  extract(opts: {
    image: Uint8Array;
    mediaType: VisionMediaType;
    apiKey?: string;
    model: string;
  }): Promise<VisualTextResult>;
}
