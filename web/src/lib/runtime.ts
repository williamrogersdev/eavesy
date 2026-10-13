export type Runtime =
  | 'web-anonymous'
  | 'web-signed-in'
  | 'desktop'
  | 'mobile-webview';

export function detectRuntime(): Runtime {
  if (typeof window === 'undefined') return 'web-anonymous';
  if ('__TAURI__' in window && window.__TAURI__) return 'desktop';
  if ('ReactNativeWebView' in window && window.ReactNativeWebView) return 'mobile-webview';
  return 'web-anonymous';
}

export const ANONYMOUS_TOKEN_STORAGE_KEY = 'eavesy.anonymousToken';

export function newAnonymousToken(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `anon_${crypto.randomUUID()}`;
  }
  return `anon_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}
