import { expect, test, type Page } from '@playwright/test';

// The desk at sizes other than the TV: phones, tablets, laptops and wide monitors.
const FAKE = 'http://127.0.0.1:18000';
const NEWS = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa';

const newsOrder = async (page: Page) => ((await (await page.request.get(`${FAKE}/__test/state`)).json()) as { lineups: Record<string, Array<{ id?: string; type: string }>> }).lineups[NEWS].map((item) => item.id?.slice(-1) ?? item.type);
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const open = async (page: Page) => {
  await page.request.post(`${FAKE}/__test/reset`);
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
  await expect(page.locator('.program').first()).toBeVisible();
};

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test.beforeEach(async ({ page }) => open(page));

  test('fits the screen and reaches every menu from one Menu sheet', async ({ page }) => {
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expect(page.getByRole('menuitem', { name: 'File' })).toBeHidden();
    await page.getByRole('menuitem', { name: 'Menu' }).click();
    const sheet = page.getByRole('menu', { name: 'All menus' });
    for (const title of ['File', 'Edit', 'View', 'Channel', 'Lists', 'Setup', 'Help']) await expect(sheet.getByRole('group', { name: title })).toBeVisible();
    await sheet.getByRole('menuitem', { name: /Keyboard & Remote Shortcuts/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('edits from the Program Info sheet and saves', async ({ page }) => {
    await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
    const sheet = page.locator('.inspector');
    // Collapsed: the program and its everyday actions, not the details.
    await expect(sheet.getByRole('button', { name: 'Insert…' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Remove' })).toBeVisible();
    await expect(sheet.getByText('Position')).toBeHidden();
    await sheet.getByRole('button', { name: /Later/ }).click();
    await page.getByRole('button', { name: 'Show details' }).click();
    await expect(sheet.getByText('Position')).toBeVisible();
    await expect(sheet.locator('.edit-list')).toBeVisible();
    await page.getByRole('button', { name: 'Hide details' }).click();
    await page.getByRole('button', { name: 'Save lineup' }).click();
    await expect.poll(() => newsOrder(page)).toEqual(['flex', '1', '2', 'redirect', '3', '4']);
  });

  test('switches channels from the channel strip', async ({ page }) => {
    await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
    await expect(page.locator('.channel.active')).toContainText('Desk Rotation');
    await expect(page.locator('.channel.active')).toBeInViewport();
  });
});

for (const [name, width, height] of [['tablet', 768, 1024], ['laptop', 1280, 800], ['ultrawide', 2560, 1080]] as const) {
  test.describe(name, () => {
    test.use({ viewport: { width, height } });
    test(`fits ${width}×${height} with the full menu bar`, async ({ page }) => {
      await open(page);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expect(page.getByRole('menuitem', { name: 'Channel' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Menu' })).toBeHidden();
      const [brand, actions] = await Promise.all([page.locator('.brand').boundingBox(), page.locator('.top-actions').boundingBox()]);
      expect(brand!.x + brand!.width).toBeLessThanOrEqual(actions!.x);
      // Type scales with the smaller of width and height, so a short wide monitor isn't TV-sized.
      if (name === 'ultrawide') expect(await page.evaluate(() => Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize)))).toBe(24);
    });
  });
}
