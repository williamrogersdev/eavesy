import { expect, test } from 'bun:test';
import { feedbackTargetIds, parseAgentFeedback } from './agent-feedback';

const report = { id: 'afb_1', kind: 'typo', targetType: 'meeting', targetId: 'meet_1', explanation: 'Misspelt.' };

test('a report on an item made on a Mac is found by both its cloud id and the Mac’s', () => {
  const item = parseAgentFeedback({ ...report, targetClientId: 'local-session-1' })!;
  expect(feedbackTargetIds(item)).toEqual(['meet_1', 'local-session-1']);
});

test('a report without a Mac id is found by its cloud id alone', () => {
  const item = parseAgentFeedback(report)!;
  expect(item.targetClientId).toBeNull();
  expect(feedbackTargetIds(item)).toEqual(['meet_1']);
});
