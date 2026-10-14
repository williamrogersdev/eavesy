import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const publicRoutes = [
  '/',
  '/features',
  '/how-it-works',
  '/security',
  '/docs',
  '/docs/getting-started',
  '/about',
  '/blog',
  '/blog/introducing-note-taker',
  '/changelog',
  '/contact',
  '/download/mac',
  '/features/files-you-own',
  '/integrations',
  '/integrations/zoom',
  '/privacy',
  '/terms',
  '/sign-in',
  '/sign-up',
  '/onboarding',
  '/this-route-does-not-exist',
] as const;

async function pageMetrics(page: Page) {
  return page.evaluate(() => ({
    clientHeight: document.documentElement.clientHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
}

for (const route of publicRoutes) {
  test(`${route} reflows without horizontal overflow`, async ({ page }) => {
    const runtimeErrors: string[] = [];
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    await page.goto(route, { waitUntil: 'networkidle' });

    const metrics = await pageMetrics(page);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(runtimeErrors).toEqual([]);
    await expect(page.locator('body')).not.toBeEmpty();
  });
}

for (const { name, width, height } of [
  { name: '320 CSS pixels', width: 320, height: 800 },
  { name: 'desktop', width: 1440, height: 1000 },
]) {
  test(`critical public routes reflow at ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const route of publicRoutes) {
      const runtimeErrors: string[] = [];
      page.removeAllListeners('pageerror');
      page.on('pageerror', (error) => runtimeErrors.push(error.message));
      await page.goto(route, { waitUntil: 'networkidle' });

      const metrics = await pageMetrics(page);
      expect(metrics.scrollWidth, `${route} overflows at ${width}px`).toBeLessThanOrEqual(
        metrics.clientWidth,
      );
      expect(runtimeErrors, `${route} raised a runtime error at ${width}px`).toEqual([]);
    }
  });
}

test('mobile navigation exposes the core product range', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open menu' }).click();
  const mobileNav = page.getByRole('navigation', { name: 'Mobile navigation' });

  for (const label of ['Features', 'How it works', 'Docs', 'Sign in']) {
    await expect(mobileNav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await expect(mobileNav.getByRole('link', { name: 'Download for Mac' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(mobileNav).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open menu' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
});

test('missing auth configuration has a recoverable sign-in screen', async ({ page }) => {
  await page.goto('/sign-in', { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('heading', { name: "Authentication isn't configured" }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return home' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Read the setup guide' })).toBeVisible();
});

test('signed-out app access reaches the recoverable sign-in path', async ({ page }) => {
  await page.goto('/app', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(
    page.getByRole('heading', { name: "Authentication isn't configured" }),
  ).toBeVisible();
});

test('signed-out recorder redirect does not leak a false first-run query', async ({ page }) => {
  await page.goto('/app/record', { waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/\/sign-in/);
  expect(page.url()).not.toContain('first%3Dfalse');
});

test('the Mac download is the primary public call to action', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const download = page.getByRole('link', { name: 'Download for Mac' }).first();
  await expect(download).toBeVisible();
  await expect(download).toHaveAttribute('href', '/download/mac?start=1');
  await expect(page.getByRole('link', { name: /Start recording free/ })).toHaveCount(0);

  await page.goto('/download/mac', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Eavesy for Mac' })).toBeVisible();
});

test('unknown routes show a branded not-found recovery path', async ({ page }) => {
  await page.goto('/this-route-does-not-exist', { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: "That page isn't here" })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Eavesy' })).toBeVisible();
});

test('desktop launcher preview is usable at its target size', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 440 });
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/launcher', { waitUntil: 'networkidle' });
  const metrics = await pageMetrics(page);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight);
  expect(runtimeErrors).toEqual([]);
  await expect(page.getByRole('button', { name: 'Record meeting', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open ⌘⇧Space/ })).toBeVisible();
});

for (const route of publicRoutes) {
  test(`${route} has no serious WCAG A/AA violations`, async ({ page }) => {
    await page.goto(route, { waitUntil: 'networkidle' });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const serious = results.violations.filter(
      ({ impact }) => impact === 'serious' || impact === 'critical',
    );
    const summary = serious.flatMap(({ id, nodes }) =>
      nodes.map((node) => `${id} ${node.target.join(' ')}: ${node.failureSummary}`),
    );
    expect(summary).toEqual([]);
  });
}
