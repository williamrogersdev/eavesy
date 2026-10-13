import { describe, expect, test } from 'bun:test';
import { parseMeetingSummary } from './summarize';

describe('parseMeetingSummary', () => {
  test('validates and normalizes provider JSON', () => {
    const summary = parseMeetingSummary(`\`\`\`json
      {
        "title": "  Release review  ",
        "description": 42,
        "tldr": "Ship after QA.",
        "decisions": [{"text": " Ship Friday "}, {"unexpected": true}],
        "actionItems": [{"text": " Test installer ", "owner": " Sam ", "due": null}],
        "followUps": "not-an-array",
        "openQuestions": [{"text": "Who signs it?"}],
        "topics": [" release ", 3, "QA"],
        "mentions": [
          {"entity": " Eavesy ", "type": "product"},
          {"entity": "Unknown", "type": "invalid"},
          {"type": "company"}
        ]
      }
    \`\`\``);

    expect(summary).toEqual({
      title: 'Release review',
      description: '',
      tldr: 'Ship after QA.',
      decisions: [{ text: 'Ship Friday' }],
      actionItems: [
        { text: 'Test installer', owner: 'Sam', due: undefined, completed: false },
      ],
      followUps: [],
      openQuestions: [{ text: 'Who signs it?' }],
      topics: ['release', 'QA'],
      mentions: [
        { entity: 'Eavesy', type: 'product' },
        { entity: 'Unknown', type: 'person' },
      ],
    });
  });

  test('rejects valid JSON with the wrong top-level shape', () => {
    expect(() => parseMeetingSummary('[]')).toThrow('was not an object');
  });

  test('extracts an object from provider prose', () => {
    expect(parseMeetingSummary('Result: {"title":"Planning"} thanks').title).toBe(
      'Planning',
    );
  });
});
