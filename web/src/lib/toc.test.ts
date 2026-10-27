import { describe, expect, test } from 'bun:test';
import { extractToc } from './toc';

describe('extractToc', () => {
  test('returns only level 2 and 3 headings', () => {
    const toc = extractToc(['# Title', '## Install', '### On a Mac', '#### Details', '##NoSpace', 'Body ## text'].join('\n'));
    expect(toc).toEqual([
      { depth: 2, text: 'Install', id: 'install' },
      { depth: 3, text: 'On a Mac', id: 'on-a-mac' },
    ]);
  });

  test('skips headings inside backtick and tilde fences', () => {
    const source = ['## Before', '```bash', '## Not a heading', '```', '~~~', '### Also not', '~~~', '  ```', '## Indented fence', '  ```', '## After'].join('\n');
    expect(extractToc(source).map((item) => item.text)).toEqual(['Before', 'After']);
  });

  test('suffixes repeated headings in document order', () => {
    const toc = extractToc(['## Setup', '### Setup', '## Usage', '## Setup'].join('\n'));
    expect(toc.map((item) => item.id)).toEqual(['setup', 'setup-1', 'usage', 'setup-2']);
  });

  test('strips inline markdown from text and id', () => {
    const toc = extractToc(['## Use [the CLI](/docs/cli)', '### *Fast* `eavesy` _mode_', '## Closing hashes ##'].join('\n'));
    expect(toc).toEqual([
      { depth: 2, text: 'Use the CLI', id: 'use-the-cli' },
      { depth: 3, text: 'Fast eavesy mode', id: 'fast-eavesy-mode' },
      { depth: 2, text: 'Closing hashes', id: 'closing-hashes' },
    ]);
    for (const { id } of toc) expect(id).not.toMatch(/[[\]()*`_/]/);
  });

  test('drops punctuation from ids and skips headings that strip to nothing', () => {
    expect(extractToc("## What's new? (v2.0)\n## **")).toEqual([{ depth: 2, text: "What's new? (v2.0)", id: 'whats-new-v20' }]);
  });
});
