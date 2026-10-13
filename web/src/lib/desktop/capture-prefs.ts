const KEY = 'eavesy.includeComputerAudio';
const EVENT = 'eavesy:capture-prefs';

export function includeComputerAudio(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setIncludeComputerAudio(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Storage unavailable: the toggle simply won't persist.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onCapturePrefsChanged(cb: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === KEY) cb(); };
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', onStorage);
  };
}
