import { describe, expect, test } from 'bun:test';
import { errMsg } from './errors';

describe('errMsg', () => {
  test('keeps the string a Tauri command rejects with', () => {
    expect(errMsg('Microphone access is off', 'fallback')).toBe('Microphone access is off');
  });
  test('reads Error and error-like objects', () => {
    expect(errMsg(new Error('boom'), 'fallback')).toBe('boom');
    expect(errMsg({ message: 'shaped' }, 'fallback')).toBe('shaped');
  });
  test('falls back for empty or unknown values', () => {
    expect(errMsg('', 'fallback')).toBe('fallback');
    expect(errMsg(undefined, 'fallback')).toBe('fallback');
    expect(errMsg(42)).toBe('Something went wrong');
  });
});
