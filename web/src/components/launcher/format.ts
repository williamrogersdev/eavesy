import type { Recording } from '@/lib/launcher/types';
import { formatDuration } from '@/lib/utils';

export function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export const SOURCE_LABEL: Record<Recording['source'], string> = {
  system: 'System audio',
  mic: 'Microphone',
  both: 'Mic + system',
  dictation: 'Dictation',
  upload: 'Upload',
  screen: 'Screen + audio',
  screenshot: 'Screenshot',
  note: 'Note',
  image: 'Image',
};

export function recordingMarkdown(rec: Recording): string {
  const when = new Date(rec.startedAt).toLocaleString();
  const lines = [
    `# ${rec.title}`,
    '',
    `_${when} · ${formatDuration(rec.durationSec * 1000)} · ${SOURCE_LABEL[rec.source]}_`,
    '',
  ];
  if (rec.summary) lines.push('## Summary', '', rec.summary, '');
  if (rec.transcript) lines.push('## Transcript', '', rec.transcript, '');
  return lines.join('\n');
}

export function downloadMarkdown(rec: Recording) {
  const blob = new Blob([recordingMarkdown(rec)], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${rec.title.replace(/[\\/:*?"<>|]/g, '').slice(0, 80) || 'recording'}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
