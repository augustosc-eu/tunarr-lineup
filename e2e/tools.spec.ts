import { expect, test, type Page } from '@playwright/test';

// The guide grid, watching, the lineup check, snapshots, the week view and
// scheduled changes, against the built companion and the fake Tunarr.
const FAKE = 'http://127.0.0.1:18000';
const NEWS = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa';

type FakeState = { streamRequests: string[]; lineups: Record<string, Array<{ id?: string; type: string }>> };
/** The companion keeps unsaved work for every browser; start each test without any. */
const clearSharedDrafts = async (page: Page) => {
  const drafts = (await (await page.request.get('/api/tunarr/drafts')).json()) as Array<{ channelId: string }>;
  for (const draft of drafts) await page.request.delete(`/api/tunarr/drafts/${draft.channelId}`);
};
const fakeState = async (page: Page) => (await (await page.request.get(`${FAKE}/__test/state`)).json()) as FakeState;
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  await clearSharedDrafts(page);
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
  await expect(page.locator('.program').first()).toBeVisible();
});

test('shows viewer counts without passing on who is watching', async ({ page }) => {
  await expect(page.locator('.channel.active .viewer-badge')).toHaveText('● 3');
  const sessions = await page.request.get('/api/tunarr/sessions');
  expect(await sessions.text()).not.toContain('10.9.8.7');
  expect(await page.content()).not.toContain('LivingRoomTV');
});

test('opens the guide grid with the remote, moves through it and opens a program in the desk', async ({ page }) => {
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('g');
  const grid = page.getByRole('grid', { name: 'Program guide' });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole('gridcell').first()).toBeVisible();
  await expect(grid.locator('.guide-cell.focused')).toHaveCount(1);
  const before = await grid.locator('.guide-cell.focused').getAttribute('aria-label');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => grid.locator('.guide-cell.focused').getAttribute('aria-label')).not.toBe(before);
  await noOverflow(page);
  await page.keyboard.press('Enter');
  await expect(grid).toBeHidden();
  await expect(page.locator('.program.cursor')).toHaveCount(1);
});

test('watches a channel live through the companion only', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('l');
  await expect(page.getByRole('dialog', { name: /CH \d+ Desk News/ })).toBeVisible();
  // hls.js loads the master and variant playlists and the first segment, all rewritten to /api/tunarr.
  await expect.poll(async () => (await fakeState(page)).streamRequests).toEqual(expect.arrayContaining([`/stream/channels/${NEWS}.m3u8?mode=hls`, `/stream/channels/${NEWS}/hls/stream.m3u8`, `/stream/channels/${NEWS}/hls/data000000.ts`]));
  expect([...origins]).toEqual(['http://127.0.0.1:13000']);
  // The remote sits beside the picture; the cable guide opens inside it.
  await expect(page.getByRole('complementary', { name: 'Remote control' })).toBeVisible();
  await page.keyboard.press('g');
  const guide = page.getByRole('grid', { name: 'Cable guide' });
  await expect(guide.locator('.cable-cell.focused')).toHaveCount(1);
  await noOverflow(page);
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.watch-modal')).toHaveCount(0);
});

test('checks the lineup, and keeps a snapshot before each save that can be restored', async ({ page }) => {
  await page.keyboard.press('c');
  const check = page.getByRole('dialog', { name: 'Check lineup' });
  await expect(check).toBeVisible();
  await expect(check.getByRole('status')).toBeVisible();
  await check.getByRole('button', { name: 'Done' }).click();

  // Save a change: the companion keeps the lineup as it was.
  await page.locator('.program').first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.getByRole('button', { name: 'Save lineup' }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /^Snapshots/ }).click();
  const snapshots = page.getByRole('dialog', { name: 'Snapshots' });
  await expect(snapshots.getByText('Before a lineup save')).toBeVisible();
  await snapshots.getByRole('button', { name: 'Restore…' }).click();
  await expect(page.getByRole('button', { name: 'Save lineup' })).toBeVisible();
  await expect(page.locator('.edit-list')).toContainText('Restored the lineup from');
});

test('shows the week and exports it as a program log', async ({ page }) => {
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('w');
  const week = page.getByRole('grid', { name: 'Week' });
  await expect(week.getByRole('columnheader')).toHaveCount(7);
  await noOverflow(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export week log…' }).click();
  expect((await download).suggestedFilename()).toMatch(/^program-log-ch\d+-week-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('plans a dated save, lists it, and cancels it', async ({ page }) => {
  await page.locator('.program').first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /^Save Later/ }).click();
  const plan = page.getByRole('dialog', { name: 'Save later' });
  await plan.getByLabel('Plan name').fill('Fall schedule');
  await plan.getByRole('button', { name: 'Schedule save' }).click();
  await expect(plan).toBeHidden();
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: /^Scheduled Changes/ }).click();
  const list = page.getByRole('dialog', { name: 'Scheduled changes' });
  await expect(list.getByText(/Fall schedule/)).toBeVisible();
  await list.getByRole('button', { name: 'Cancel Fall schedule' }).click();
  await expect(list.getByRole('list', { name: 'Recent changes' })).toContainText('Cancelled');
  // Nothing was saved to Tunarr by planning it.
  expect((await fakeState(page)).lineups[NEWS][0].id).not.toBeUndefined();
});

test('changes a server setting from the desk with the keyboard, then goes back to .env', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Setup' }).click();
  await page.getByRole('menuitem', { name: /Server Settings/ }).press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Server settings' });
  const timeout = dialog.getByLabel('AI timeout (seconds)');
  await expect(timeout).toHaveValue('180');
  // Secrets and addresses are only reported as set.
  await expect(dialog.getByLabel('Settings kept in .env')).toContainText('Tunarr addressSet');
  await expect(dialog).not.toContainText('127.0.0.1');
  await timeout.fill('240');
  await dialog.getByRole('button', { name: 'Save settings' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByRole('status')).toHaveText('Settings saved.');
  await expect(dialog.locator('.server-setting', { hasText: 'AI timeout' })).toContainText('Saved here');
  await noOverflow(page);
  await page.screenshot({ path: test.info().outputPath('server-settings.png') });
  await dialog.getByRole('button', { name: 'Use the .env value for AI timeout' }).press('Enter');
  await expect(dialog.getByRole('status')).toContainText('AI timeout is back to its default.');
  await expect(timeout).toHaveValue('180');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect((await (await page.request.get('/api/tunarr/server-settings')).json()).editable.every((item: { source: string }) => item.source !== 'saved')).toBe(true);
});
