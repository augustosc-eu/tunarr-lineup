import { expect, test, type Page } from '@playwright/test';

const FAKE = 'http://127.0.0.1:18000';
const NEWS = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa';

type FakeState = { lineups: Record<string, Array<{ id?: string; type: string }>>; saves: number };
const fakeState = async (page: Page) => (await (await page.request.get(`${FAKE}/__test/state`)).json()) as FakeState;
const newsOrder = async (page: Page) => (await fakeState(page)).lineups[NEWS].map((item) => item.id?.slice(-1) ?? item.type);

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
  await expect(page.locator('.program').first()).toBeVisible();
});

test('opens a live desk at TV resolution without leaving its own origin', async ({ page }) => {
  const origins = new Set<string>();
  const errors: string[] = [];
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.reload();
  await expect(page.locator('.program.on-air')).toHaveCount(1);
  await expect(page.getByText('ON AIR')).toBeVisible();
  await expect(page.getByText('Tunarr connected')).toBeVisible();
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.art img')].filter((image) => image.naturalWidth > 0).length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect([...origins]).toEqual(['http://127.0.0.1:13000']);
  expect(errors).toEqual([]);
});

test('picks up, slides and drops with remote keys, then saves and persists', async ({ page }) => {
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.moving-chip')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.moving-chip')).toHaveCount(0);
  await expect(page.locator('.edit-list')).toContainText('Moved “Alpha Hour” 2 places later');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toHaveText('Lineup saved to Tunarr');
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  expect(await newsOrder(page)).toEqual(['flex', '2', '1', 'redirect', '3', '4']);

  await page.reload();
  await expect(page.locator('.program').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.getByRole('button', { name: 'Move or swap…' }).click();
  await expect(page.getByText('Currently #1 of 6')).toBeVisible();
  expect((await fakeState(page)).saves).toBe(1);
});

test('refuses to overwrite a lineup that changed in Tunarr meanwhile', async ({ page }) => {
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.request.post(`${FAKE}/__test/edit-elsewhere?channel=${NEWS}`);
  await page.getByRole('button', { name: 'Save lineup' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('This channel changed in Tunarr');
  expect((await fakeState(page)).saves).toBe(0);
  await dialog.getByRole('button', { name: 'Reload from Tunarr' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  expect((await fakeState(page)).saves).toBe(0);
});

test('menus work from the keyboard, and Go to Now selects the on-air program', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'View' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menu', { name: 'View' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Go to Now/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'View' })).toHaveCount(0);
  await expect(page.locator('.program.on-air.cursor')).toHaveCount(1);
});

test('exports the visible day as a program log', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'File' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Export Program Log/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^program-log-ch5-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await (await file.createReadStream()).toArray().then((chunks) => Buffer.concat(chunks).toString('utf8'));
  expect(text.split('\r\n')[0]).toBe('Date,Start,End,Duration,Type,Title,Detail,Lineup position');
  expect(text).toContain('Alpha Hour');
});

test('keeps the connection status reachable at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Tunarr connected' }).click();
  await expect(page.getByRole('dialog')).toContainText('Tunarr connected.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});
