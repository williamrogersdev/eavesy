export type Decision = { text: string; sourceSegmentId?: string };

export type ActionItem = {
  text: string;
  owner?: string;
  due?: string;
  sourceSegmentId?: string;
  completed: boolean;
};

export type Sourced = { text: string; sourceSegmentId?: string };

export type Mention = {
  entity: string;
  type: 'person' | 'product' | 'company' | 'project';
};

export function decode<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export function encode(value: unknown): string {
  return JSON.stringify(value);
}
