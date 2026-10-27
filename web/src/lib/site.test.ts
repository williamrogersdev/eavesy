import { describe, expect, test } from 'bun:test';
import { absoluteUrl, siteConfig } from './site';

describe('absoluteUrl', () => {
  test('returns the site URL for the root', () => {
    expect(absoluteUrl()).toBe(siteConfig.url);
    expect(absoluteUrl('/')).toBe(siteConfig.url);
    expect(siteConfig.url.endsWith('/')).toBe(false);
  });

  test('adds a leading slash when the path has none', () => {
    expect(absoluteUrl('/docs')).toBe(`${siteConfig.url}/docs`);
    expect(absoluteUrl('docs')).toBe(`${siteConfig.url}/docs`);
    expect(absoluteUrl('docs/getting-started')).toBe(`${siteConfig.url}/docs/getting-started`);
  });
});
