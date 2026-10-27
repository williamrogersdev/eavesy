'use client';

import { speakerName } from '@/lib/transcription/two-track';
import { type Segment } from './types';
import { CopyButton } from './copy-buttons';
import { Section } from './layout';

export function TranscriptSection({
  segments,
  overrideMd,
}: {
  segments: Segment[];
  overrideMd?: string | null;
}) {
  if (overrideMd) {
    return (
      <Section title="Edited transcript" action={<CopyButton text={overrideMd} label="Copy transcript" />}>
        <pre className="max-h-[32rem] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ev-ink">
          {overrideMd}
        </pre>
      </Section>
    );
  }
  if (!segments?.length) return null;

  const text = segments
    .map((s) => `${s.speakerId ? speakerName(s.speakerId, {}) + ': ' : ''}${s.text}`)
    .join('\n');

  return (
    <Section
      title="Transcript"
      action={
        <CopyButton text={text} label="Copy transcript" />
      }
    >
      <div className="max-h-[32rem] space-y-2 overflow-y-auto text-sm leading-relaxed text-ev-ink">
        {segments.map((s, i) => (
          <p key={i}>
            {s.speakerId ? <strong className="mr-1">{speakerName(s.speakerId, {})}:</strong> : null}
            {s.text}
          </p>
        ))}
      </div>
    </Section>
  );
}
