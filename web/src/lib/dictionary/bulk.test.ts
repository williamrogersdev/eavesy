import { expect, test } from 'bun:test';
import { parseReplacements } from './bulk';

test('reads the usual ways of writing "heard → type", one per line', () => {
  expect(parseReplacements('easy → Eavesy\ncube cuddle -> kubectl\nnext js => Next.js\npost hog\tPostHog\nd one = D1').entries).toEqual([
    { from: 'easy', to: 'Eavesy' },
    { from: 'cube cuddle', to: 'kubectl' },
    { from: 'next js', to: 'Next.js' },
    { from: 'post hog', to: 'PostHog' },
    { from: 'd one', to: 'D1' },
  ]);
});

test('skips blank lines, reports lines without two sides, and keeps the last of a repeat', () => {
  const { entries, unread } = parseReplacements('\n  easy → Eavesy  \nEavesy\n→ nothing\neasy → Eavesy app\n');
  expect(entries).toEqual([{ from: 'easy', to: 'Eavesy app' }]);
  expect(unread).toEqual(['Eavesy', '→ nothing']);
});

test('splits at the first separator and leaves commas and colons alone', () => {
  expect(parseReplacements('a = b → c\nKubernetes, k8s\nnote: Eavesy').entries).toEqual([{ from: 'a', to: 'b → c' }]);
  expect(parseReplacements('x => y').entries).toEqual([{ from: 'x', to: 'y' }]);
});
