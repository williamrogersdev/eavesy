import { expect, test } from 'bun:test';
import { claudeCodeCommand, fillPrompt, freeSlug, matchPrompts, PROMPT_LIMITS, promptSlug, promptsOnly, type SavedPrompt } from './prompts';

const prompt = (name: string, slug: string, body = '', useCount = 0): SavedPrompt =>
  ({ id: slug, name, slug, body, useCount, lastUsedAt: null, updatedAt: 0 });

test('a name becomes a slash-command name', () => {
  expect(promptSlug('Debug support tickets!')).toBe('debug-support-tickets');
  expect(promptSlug('  Café — résumé  ')).toBe('cafe-resume');
  expect(promptSlug('???')).toBe('prompt');
  expect(promptSlug('x'.repeat(200)).length).toBe(PROMPT_LIMITS.slug);
  expect(claudeCodeCommand('triage')).toBe('/mcp__eavesy__triage');
});

test('a taken slug gets a number, and stays within the length limit', () => {
  expect(freeSlug('triage', new Set())).toBe('triage');
  expect(freeSlug('triage', new Set(['triage', 'triage-2']))).toBe('triage-3');
  const long = 'a'.repeat(PROMPT_LIMITS.slug);
  const next = freeSlug(long, new Set([long]));
  expect(next.endsWith('-2')).toBe(true);
  expect(next.length).toBe(PROMPT_LIMITS.slug);
});

test('details fill the slot, or follow the prompt', () => {
  expect(fillPrompt('Triage the tickets.', 'only billing')).toBe('Triage the tickets.\n\nonly billing');
  expect(fillPrompt('Triage the tickets.\n', '  ')).toBe('Triage the tickets.\n');
  expect(fillPrompt('Look at {{details}} first, then plan.', 'billing')).toBe('Look at billing first, then plan.');
  expect(fillPrompt('Focus: {{details}}')).toBe('Focus:');
});

test('a search finds prompts by name first, then by text, and "/" alone lists them by use', () => {
  const prompts = [
    prompt('Implement the plan', 'implement', 'Go step by step.', 1),
    prompt('Triage support tickets', 'triage', 'Search every ticket and debug.', 9),
    prompt('Write a plan', 'plan', 'Make a plan to fix it.', 3),
  ];
  expect(matchPrompts(prompts, '').map((p) => p.slug)).toEqual([]);
  expect(matchPrompts(prompts, '/').map((p) => p.slug)).toEqual(['triage', 'plan', 'implement']);
  expect(matchPrompts(prompts, '/tri').map((p) => p.slug)).toEqual(['triage']);
  expect(matchPrompts(prompts, 'plan').map((p) => p.slug)).toEqual(['plan', 'implement']);
  expect(matchPrompts(prompts, 'debug').map((p) => p.slug)).toEqual(['triage']);
  expect(matchPrompts(prompts, 'nothing like it')).toEqual([]);
  expect(promptsOnly(' /tri')).toBe(true);
  expect(promptsOnly('tri')).toBe(false);
});
