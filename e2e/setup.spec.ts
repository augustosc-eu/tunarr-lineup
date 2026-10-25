import { expect, test, type Page } from '@playwright/test';

// The second companion in playwright.config.ts starts with nothing set up.
const SETUP = 'http://127.0.0.1:13001';
const FAKE = 'http://127.0.0.1:18000';
const CODE = 'SETUP-E2E22';

test.use({ httpCredentials: undefined });

const noSideScroll = async (page: Page) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
};

test('sets up a fresh server from the browser, then asks for the new sign-in', async ({ page, browser }) => {
  await page.goto(SETUP);
  await expect(page.getByRole('heading', { name: 'Set up Tunarr Lineup' })).toBeVisible();
  await noSideScroll(page);
  // Until setup is done, nothing else answers.
  expect((await page.request.get(`${SETUP}/api/tunarr/channels`)).status()).toBe(503);

  // Everything by keyboard, as with a TV remote.
  await page.getByLabel('Setup code').fill(CODE.toLowerCase());
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Tunarr address')).toBeFocused();
  // Detection runs first (it may find a real Tunarr on this machine); the typed address wins.
  await expect(page.getByRole('button', { name: 'Look again' })).toBeVisible();
  await page.getByLabel('Tunarr address').fill('127.0.0.1:18000');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText(/Tunarr answered with \d+ channels/)).toBeVisible();
  await expect(page.getByLabel('Tunarr address')).toHaveValue('http://127.0.0.1:18000');
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await page.getByLabel('User name').fill('tv');
  await page.getByLabel('Password', { exact: true }).fill('remote control');
  await page.getByLabel('Password again').fill('remote control');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('AI provider')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await noSideScroll(page);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByText(/^http:\/\/127\.0\.0\.1:18000 · \d+ channels$/)).toBeVisible();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('heading', { name: 'Lineup is set up' })).toBeVisible();

  // Now everyone signs in, and the desk reads the fake Tunarr.
  expect((await page.request.get(`${SETUP}/api/tunarr/health`)).status()).toBe(401);
  const signedIn = await browser.newContext({ httpCredentials: { username: 'tv', password: 'remote control', origin: SETUP }, viewport: { width: 1920, height: 1080 } });
  const desk = await signedIn.newPage();
  const origins = new Set<string>();
  desk.on('request', (request) => origins.add(new URL(request.url()).origin));
  await desk.goto(SETUP);
  await expect(desk.getByText('Tunarr connected')).toBeVisible();
  await expect(desk.getByRole('heading', { name: 'Set up Tunarr Lineup' })).toHaveCount(0);
  expect([...origins].filter((origin) => origin !== SETUP)).toEqual([]);
  expect(origins.has(FAKE)).toBe(false);
  await signedIn.close();
});
