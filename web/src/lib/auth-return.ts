export function appReturnPath(value: unknown, fallback = '/app'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || Array.from(value).some((character) => character === '\\' || character.charCodeAt(0) <= 32)) return fallback;
  try {
    const url = new URL(value, 'https://eavesy.com');
    if (url.origin !== 'https://eavesy.com' || (url.pathname !== '/app' && !url.pathname.startsWith('/app/') && url.pathname !== '/connect/mac')) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}
