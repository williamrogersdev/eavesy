import { describe, expect, test } from 'bun:test';
import { EMBEDDING_MODEL, embedTexts } from './embed';

describe('embedTexts', () => {
  test('uses the 1024-dimensional multilingual Workers AI model', async () => {
    let model = '';
    const vector = Array.from({ length: 1024 }, (_, index) => index / 1024);
    const result = await embedTexts(
      {
        async run(value) {
          model = value;
          return { data: [vector] };
        },
      },
      ['meeting notes'],
    );
    expect(model).toBe(EMBEDDING_MODEL);
    expect(result).toEqual([vector]);
  });

  test('rejects an index-incompatible vector shape', async () => {
    expect(
      embedTexts({ async run() { return { data: [[1, 2, 3]] }; } }, ['bad']),
    ).rejects.toThrow('Embedding dimension mismatch');
  });
});
