export interface WorkersAiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

export const EMBEDDING_MODEL = '@cf/qwen/qwen3-embedding-0.6b';

export async function embedTexts(ai: WorkersAiRunner, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length > 16) {
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i += 16) vectors.push(...await embedTexts(ai, texts.slice(i, i + 16)));
    return vectors;
  }
  const result = await ai.run(EMBEDDING_MODEL, { text: texts });
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new Error('Workers AI embedding response did not contain data');
  }

  const vectors = result.data.filter(
    (candidate): candidate is number[] =>
      Array.isArray(candidate) && candidate.every((value) => typeof value === 'number'),
  );
  if (vectors.length !== texts.length) {
    throw new Error(`Workers AI returned ${vectors.length} vectors for ${texts.length} texts`);
  }
  for (const vector of vectors) {
    if (vector.length !== 1_024) {
      throw new Error(`Embedding dimension mismatch: expected 1024, received ${vector.length}`);
    }
  }
  return vectors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
