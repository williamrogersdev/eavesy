import { describe, expect, test } from 'bun:test';
import {
  findEchoLines,
  hasBothSides,
  isHallucination,
  isSilentTrack,
  speakerForTrack,
  speakerName,
  type AttributedLine,
} from './two-track';

const line = (id: string, speakerId: string | null, startMs: number, text: string): AttributedLine => ({
  id,
  speakerId,
  startMs,
  endMs: startMs + 2_000,
  text,
});

describe('speaker attribution', () => {
  test('the mic is you and the computer audio is them', () => {
    expect(speakerForTrack('mic')).toBe('you');
    expect(speakerForTrack('system')).toBe('them');
    expect(speakerForTrack('mixed')).toBeNull();
  });

  test('a silent track is skipped, an unknown level is not', () => {
    expect(isSilentTrack('system', 0)).toBe(true);
    expect(isSilentTrack('system', 30_000)).toBe(false);
    expect(isSilentTrack('mic', null)).toBe(false);
    expect(isSilentTrack('mixed', 0)).toBe(false);
  });

  test('labels need both sides to have spoken', () => {
    expect(hasBothSides([{ speakerId: 'you' }, { speakerId: 'you' }])).toBe(false);
    expect(hasBothSides([{ speakerId: 'you' }, { speakerId: 'them' }])).toBe(true);
    expect(hasBothSides([{ speakerId: null }])).toBe(false);
  });

  test('renames win over defaults', () => {
    expect(speakerName('you', null)).toBe('You');
    expect(speakerName('you', { you: 'Will' })).toBe('Will');
    expect(speakerName('speaker_1', {})).toBe('Speaker 2');
  });
});

describe('echo removal', () => {
  test('drops a mic line that repeats what the other side said moments earlier', () => {
    const lines = [
      line('t1', 'them', 10_000, 'Can everyone see the launch checklist on my screen?'),
      line('y1', 'you', 11_200, 'everyone see the launch checklist on my screen'),
    ];
    expect(findEchoLines(lines)).toEqual(['y1']);
  });

  test('keeps your own words, even when you both talk at once', () => {
    const lines = [
      line('t1', 'them', 10_000, 'Can everyone see the launch checklist on my screen?'),
      line('y1', 'you', 10_500, 'Yes, I can see it, the second item is mine.'),
    ];
    expect(findEchoLines(lines)).toEqual([]);
  });

  test('keeps a repeat that is too far away in time to be echo', () => {
    const lines = [
      line('t1', 'them', 10_000, 'we ship on friday afternoon'),
      line('y1', 'you', 60_000, 'we ship on friday afternoon'),
    ];
    expect(findEchoLines(lines)).toEqual([]);
  });

  test('short lines must match exactly', () => {
    const lines = [
      line('t1', 'them', 10_000, 'Sounds good to me.'),
      line('y1', 'you', 10_400, 'sounds good'),
      line('y2', 'you', 10_400, 'good morning'),
    ];
    expect(findEchoLines(lines)).toEqual(['y1']);
  });
});

describe('hallucination filter', () => {
  test('drops bracketed markers and doubtful stock phrases', () => {
    expect(isHallucination({ text: '[BLANK_AUDIO]' })).toBe(true);
    expect(isHallucination({ text: ' (music) ' })).toBe(true);
    expect(isHallucination({ text: 'Thanks for watching!' })).toBe(true);
    expect(isHallucination({ text: 'Subtitles by the Amara.org community' })).toBe(true);
  });

  test('keeps a real thank-you when Whisper heard speech', () => {
    expect(isHallucination({ text: 'Thank you.', noSpeechProb: 0.05 })).toBe(false);
    expect(isHallucination({ text: 'Thank you so much for joining.' })).toBe(false);
  });

  test('drops looping or no-speech text', () => {
    expect(isHallucination({ text: 'the the the the', compressionRatio: 3.1 })).toBe(true);
    expect(isHallucination({ text: 'something', noSpeechProb: 0.9 })).toBe(true);
  });
});
