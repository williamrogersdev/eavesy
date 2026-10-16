import { describe, expect, test } from 'bun:test';
import { parseVersionedDmgName } from './mac-dmg-name';

describe('parseVersionedDmgName', () => {
  test('accepts release DMG names', () => {
    expect(parseVersionedDmgName('Eavesy_0.1.9_aarch64.dmg')).toEqual({ version: '0.1.9', arch: 'aarch64' });
    expect(parseVersionedDmgName('Eavesy_12.0.31_x64.dmg')).toEqual({ version: '12.0.31', arch: 'x64' });
  });

  test('rejects anything that could reach another R2 object', () => {
    for (const name of [
      'eavesy-latest.dmg',
      'latest.json',
      'Eavesy_0.1.9_aarch64.app.tar.gz',
      'Eavesy_0.1_aarch64.dmg',
      'Eavesy_0.1.9_arm64.dmg',
      '../Eavesy_0.1.9_aarch64.dmg',
      'Eavesy_0.1.9-beta_aarch64.dmg',
      'Eavesy_0.1.9_aarch64.dmg/x',
    ]) {
      expect(parseVersionedDmgName(name)).toBeNull();
    }
  });
});
