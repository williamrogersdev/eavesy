/** Versioned DMG artifact names as published by desktop/scripts/release-macos.sh. */
const VERSIONED_DMG = /^Eavesy_(\d+\.\d+\.\d+)_(aarch64|x64)\.dmg$/;

export function parseVersionedDmgName(file: string): { version: string; arch: 'aarch64' | 'x64' } | null {
  const match = VERSIONED_DMG.exec(file);
  if (!match) return null;
  return { version: match[1], arch: match[2] as 'aarch64' | 'x64' };
}
