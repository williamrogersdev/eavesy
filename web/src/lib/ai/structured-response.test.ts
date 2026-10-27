import { expect, test } from 'bun:test';
import { answerLibrary } from './library-answer';
import { creditSummary } from './credit-summary';
const source = { id: 's', meetingId: 'm', title: 'Synthetic', startMs: 0, endMs: 1000, text: 'We agreed to launch Friday.' };
for (const shape of ['object', 'string']) {
  test(`accepts Workers AI structured ${shape} responses without weakening citations`, async () => {
    const reply = { claims: [{ text: 'Launch is Friday.', kind: 'decision', sourceIds: ['s'] }], unanswered: [] };
    const ai = { run: async () => ({ response: shape === 'object' ? reply : JSON.stringify(reply) }) };
    expect((await answerLibrary(ai, 'When is launch?', [source])).claims[0].citations[0].id).toBe('s');
    const summary = { title: 'Launch', description: '', tldr: 'Launch is Friday.', decisions: [], actionItems: [], followUps: [], openQuestions: [], topics: [], mentions: [] };
    expect((await creditSummary({ run: async () => ({ response: shape === 'object' ? summary : JSON.stringify(summary) }) }, { transcript: source.text })).title).toBe('Launch');
  });
}
