import { expect, test } from 'bun:test';
import { appReturnPath } from './auth-return';
test('pairing target survives onboarding and rejects external destinations', () => {
  expect(appReturnPath('/app/settings?pair=ABC123')).toBe('/app/settings?pair=ABC123');
  expect(appReturnPath('/connect/mac?code=ABC123')).toBe('/connect/mac?code=ABC123');
  expect(appReturnPath('/connect/other')).toBe('/app');
  for (const value of ['//evil.example/app', '/\\evil.example/app', 'https://evil.example/app', '/onboarding', '/application', '/app/../../sign-in', '/app\n//evil']) {
    expect(appReturnPath(value)).toBe('/app');
  }
});
