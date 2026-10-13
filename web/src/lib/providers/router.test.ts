import { describe, expect, test } from 'bun:test';
import { resolveModelPlan } from './router';

describe('resolveModelPlan', () => {
  test('anonymous/empty → platform everywhere, no OpenRouter', () => {
    const plan = resolveModelPlan(null);
    expect(plan.openRouter).toBeNull();
    expect(plan.summary.billedTo).toBe('platform');
    expect(plan.vision.billedTo).toBe('platform');
    expect(plan.summary.apiKey).toBeUndefined();
    expect(plan.transcription.engine).toBe('whisper');
  });

  test('BYO Anthropic key bills vision + summary to the user', () => {
    const plan = resolveModelPlan({ byoAnthropicKey: 'sk-ant-abc' });
    expect(plan.summary).toMatchObject({ apiKey: 'sk-ant-abc', billedTo: 'user' });
    expect(plan.vision).toMatchObject({ apiKey: 'sk-ant-abc', billedTo: 'user' });
    expect(plan.openRouter).toBeNull();
  });

  test('OpenRouter connection is surfaced separately and never leaks into the Anthropic field', () => {
    const plan = resolveModelPlan({
      byoOpenRouterKey: 'sk-or-xyz',
      byoAnthropicKey: 'sk-ant-abc',
    });
    expect(plan.openRouter).toEqual({ apiKey: 'sk-or-xyz' });
    expect(plan.summary.apiKey).toBe('sk-ant-abc');
    expect(plan.vision.apiKey).toBe('sk-ant-abc');
    expect(plan.summary.apiKey).not.toContain('sk-or-');
  });

  test('blank/whitespace keys are treated as absent', () => {
    const plan = resolveModelPlan({ byoOpenRouterKey: '   ', byoAnthropicKey: '' });
    expect(plan.openRouter).toBeNull();
    expect(plan.summary.billedTo).toBe('platform');
  });

  test('legacy engine preferences are normalized to Workers AI Whisper', () => {
    const plan = resolveModelPlan({ defaultTranscriptionEngine: 'deepgram' });
    expect(plan.transcription).toEqual({ engine: 'whisper', billedTo: 'platform' });
  });
});
