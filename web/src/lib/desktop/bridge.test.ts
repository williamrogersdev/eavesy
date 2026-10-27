import { afterEach, describe, expect, test } from 'bun:test';
import { isDesktop } from './bridge';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
function setWindow(value: unknown) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
}

describe('isDesktop', () => {
  test('is false with no window, as during server rendering', () => {
    setWindow(undefined);
    expect(isDesktop()).toBe(false);
  });

  test('is true when the Tauri global is present', () => {
    setWindow({ __TAURI__: { core: { invoke: async () => null } } });
    expect(isDesktop()).toBe(true);
  });

  test('is false in a plain browser or mobile WebView', () => {
    setWindow({});
    expect(isDesktop()).toBe(false);
    setWindow({ __TAURI__: undefined });
    expect(isDesktop()).toBe(false);
    setWindow({ ReactNativeWebView: { postMessage: () => {} } });
    expect(isDesktop()).toBe(false);
  });
});
