import { expect, test } from '@playwright/test';

const appRoutes = [
  ['library', '/app'],
  ['library-captures', '/app?tab=captures'],
  ['meeting', '/app/meetings/mtg_local_complete'],
  ['meeting-processing', '/app/meetings/mtg_local_processing'],
  ['meeting-failed', '/app/meetings/mtg_local_failed'],
  ['capture', '/app/captures/cap_local_screenshot'],
  ['record', '/app/record'],
  ['dictation', '/app/dictation'],
  ['search', '/app/search'],
  ['settings', '/app/settings'],
] as const;

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([{ name: 'eavesy_local_test', value: '1', url: baseURL! }]);
});

for (const { name: size, width, height } of [
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]) {
  test(`signed-in pages render cleanly on ${size}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const [name, route] of appRoutes) {
      const runtimeErrors: string[] = [];
      page.removeAllListeners('pageerror');
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      await page.goto(route, { waitUntil: 'networkidle' });

      expect(page.url(), `${route} redirected away`).not.toMatch(/sign-in|onboarding/);
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `${route} overflows at ${width}px`).toBeLessThanOrEqual(clientWidth);
      expect(runtimeErrors, `${route} raised a runtime error`).toEqual([]);
      await page.screenshot({ path: `test-results/app-pages/${size}-${name}.png`, fullPage: true });
    }
  });
}

test('library shows the seeded recordings and captures', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'networkidle' });
  await expect(page.getByRole('link', { name: /Pricing review with Sarah/ })).toBeVisible();
  await page.getByRole('tab', { name: /Captures/ }).click();
  await expect(page).toHaveURL(/tab=captures/);
  await expect(page.getByRole('link', { name: /Checkout error/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Pricing review with Sarah/ })).toHaveCount(0);
});
