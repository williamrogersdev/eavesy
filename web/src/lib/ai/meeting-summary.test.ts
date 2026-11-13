import { describe, expect, test } from 'bun:test';
import { meetingSummarySystemPrompt } from './meeting-summary';

describe('meetingSummarySystemPrompt', () => {
  test('an assistant on the call owns nothing, unless it is a person', () => {
    const prompt = meetingSummarySystemPrompt({ transcript: '', contextBlurb: null, priorSummary: '', rolling: false, labelled: true, call: true });
    expect(prompt).toContain('is software, not an attendee, unless the transcript makes clear it is a person');
    expect(prompt).toContain('never make it the owner of an action item');
  });
});
