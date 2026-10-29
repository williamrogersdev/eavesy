/**
 * Prompts offered to someone who has none yet, before (or instead of) ones
 * written from their own dictations. No imports, like `lib/prompts.ts`.
 */

export interface PromptSuggestion {
  name: string;
  body: string;
  /** One short line on why it's offered. */
  why: string;
}

export const STARTER_PROMPTS: readonly PromptSuggestion[] = [
  {
    name: 'Review this diff',
    why: 'Catches bugs before you push.',
    body: 'Review the current diff. Look for bugs first: wrong logic, missed edge cases, error handling, security. Then anything that can be simpler. List each finding with the file and line, most serious first, and say how sure you are. Don’t change any code yet.\n\nFocus on {{details}}.',
  },
  {
    name: 'Plan before coding',
    why: 'Gets an agent to think it through first.',
    body: 'Before writing any code, read the relevant files and write a short plan: what you’ll change, in which files, and how you’ll test it. Call out anything you’re unsure about and ask me before guessing. Wait for my go-ahead.\n\nThe task: {{details}}',
  },
  {
    name: 'Fix the failing tests',
    why: 'Fixes the cause, not the test.',
    body: 'Run the tests, find out why they fail, and fix the cause in the code. Don’t weaken or delete tests to make them pass. When everything is green, tell me what was wrong in one or two sentences.',
  },
  {
    name: 'Explain this code',
    why: 'For code you didn’t write.',
    body: 'Explain how {{details}} works: what it’s for, the main flow from start to finish, and anything surprising. Point to the files and functions as you go. Keep it short and plain.',
  },
  {
    name: 'Write a reply',
    why: 'Turns notes into a clear message.',
    body: 'Write a short, friendly reply from these notes. Lead with the answer, keep it to a few sentences, and match the tone of the message I’m answering. No sign-off unless it’s an email.\n\n{{details}}',
  },
  {
    name: 'Summarize for my team',
    why: 'A quick update anyone can skim.',
    body: 'Summarize this for my team in a few bullets: what happened, what was decided, and what’s next with owners. Plain words, no filler.\n\n{{details}}',
  },
];
