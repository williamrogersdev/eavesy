import { describe, expect, test } from 'bun:test';
import { answeredBy, refusalFallback, replyText } from './client';

describe('refusalFallback', () => {
  test('asks for a server-side fallback, except from Haiku, which has none', () => {
    expect(refusalFallback('claude-sonnet-5-5')).toEqual({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(refusalFallback('claude-opus-5-5')).toMatchObject({ fallbacks: 'default' });
    expect(refusalFallback('claude-haiku-5-5')).toEqual({});
  });
});

describe('replyText', () => {
  const reply = (stop_reason: string, text = 'Half an ans') => ({ stop_reason, content: [{ type: 'thinking' }, { type: 'text', text }] });

  test('joins the text of a finished reply', () => {
    expect(replyText(reply('end_turn', 'Ship Friday.'), 'chat')).toBe('Ship Friday.');
  });

  test('throws on a declined or cut-off reply instead of passing part of it on', () => {
    expect(() => replyText(reply('refusal', ''), 'summary')).toThrow('summary refused by the model');
    expect(() => replyText(reply('max_tokens'), 'chat')).toThrow('chat truncated at max_tokens');
  });
});

describe('answeredBy', () => {
  test('names another Claude model only when the API reports one', () => {
    expect(answeredBy('claude-sonnet-5-5', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(answeredBy('claude-sonnet-5-5', 'claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(answeredBy('claude-sonnet-5-5', undefined)).toBe('claude-sonnet-5-5');
    expect(answeredBy('claude-sonnet-5-5', 'test')).toBe('claude-sonnet-5-5');
  });
});
