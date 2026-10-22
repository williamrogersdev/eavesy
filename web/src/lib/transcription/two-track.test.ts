import { describe, expect, test } from 'bun:test';
import {
  findEchoLines,
  hasBothSides,
  isHallucination,
  isQuietAudio,
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

  test('a mic-only recording is never skipped as silent', () => {
    expect(isSilentTrack('mic', 0, { micOnly: true })).toBe(false);
    expect(isSilentTrack('mic', 100, { micOnly: true })).toBe(false);
    expect(isSilentTrack('mic', 100)).toBe(true);
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

  test('a mic-only note keeps a short stock phrase unless Whisper doubted it', () => {
    const lenient = { lenient: true };
    expect(isHallucination({ text: 'Thank you.' }, lenient)).toBe(false);
    expect(isHallucination({ text: 'Bye!' }, lenient)).toBe(false);
    expect(isHallucination({ text: 'Thank you.', noSpeechProb: 0.4 }, lenient)).toBe(false);
    expect(isHallucination({ text: 'Thank you.', noSpeechProb: 0.6 }, lenient)).toBe(true);
    expect(isHallucination({ text: '[BLANK_AUDIO]' }, lenient)).toBe(true);
    expect(isHallucination({ text: 'something', noSpeechProb: 0.9 }, lenient)).toBe(true);
  });

  test('a line made only of stock phrases counts as one', () => {
    expect(isHallucination({ text: 'Thank you. Thank you.' })).toBe(true);
    expect(isHallucination({ text: 'Thank you. Here we go.' })).toBe(true);
    expect(isHallucination({ text: 'Thank you. Let’s go!' })).toBe(true);
    expect(isHallucination({ text: 'I hope you enjoyed it. See you next time!' })).toBe(true);
    expect(isHallucination({ text: 'Thank you. Send the deck tonight.' })).toBe(false);
    expect(isHallucination({ text: "Here we go, that's the plan." })).toBe(false);
    // A mic-only note still keeps stock phrases Whisper did not doubt.
    expect(isHallucination({ text: 'Thank you. Thank you.' }, { lenient: true })).toBe(false);
  });

  test('quiet audio drops stock phrases whatever their score, even on a mic-only note', () => {
    const quiet = { lenient: true, quiet: true };
    expect(isHallucination({ text: 'Thank you.', noSpeechProb: 0.05 }, quiet)).toBe(true);
    expect(isHallucination({ text: 'Thank you. Thank you', noSpeechProb: 0.1 }, quiet)).toBe(true);
    expect(isHallucination({ text: 'Thank you. Here we go' }, quiet)).toBe(true);
    expect(isHallucination({ text: 'Call the bank.' }, quiet)).toBe(false);
    expect(isQuietAudio(120)).toBe(true);
    expect(isQuietAudio(900)).toBe(false);
    expect(isQuietAudio(null)).toBe(false);
  });

  test('drops looping or no-speech text', () => {
    expect(isHallucination({ text: 'the the the the', compressionRatio: 3.1 })).toBe(true);
    expect(isHallucination({ text: 'something', noSpeechProb: 0.9 })).toBe(true);
  });
});

describe('glossary read-back', () => {
  const glossary = ['Eavesy', 'Priya Raman', 'Kubernetes'];

  test('drops a bare list of the custom words Whisper read back from its prompt', () => {
    expect(isHallucination({ text: 'Eavesy, Priya Raman, Kubernetes.', noSpeechProb: 0.6 }, { glossary })).toBe(true);
    expect(isHallucination({ text: 'Priya Raman, Eavesy.', noSpeechProb: 0.5 }, { glossary })).toBe(true);
  });

  test('keeps real speech that uses the custom words', () => {
    expect(isHallucination({ text: 'Priya Raman.' }, { glossary })).toBe(false);
    expect(isHallucination({ text: 'Kubernetes.' }, { glossary })).toBe(false);
    expect(isHallucination({ text: 'Ask Priya Raman about Eavesy.' }, { glossary })).toBe(false);
    expect(isHallucination({ text: 'Eavesy, Kubernetes.', noSpeechProb: 0.05 }, { glossary })).toBe(false);
    expect(isHallucination({ text: 'Eavesy, Kubernetes.', noSpeechProb: 0.6 }, { glossary, lenient: true })).toBe(false);
    expect(isHallucination({ text: 'Priya Raman, Kubernetes.' }, { glossary })).toBe(false);
  });
});
