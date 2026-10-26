import { expect, test, type Page } from '@playwright/test';

// Lineup against newer Tunarr releases, through the built companion and the
// fake Tunarr. 2026.10.4 removed movie slots (movies go in a custom show): the
// desk reads that from Tunarr's API description, stops offering them, and
// makes the custom show only when asked.
const FAKE = 'http://127.0.0.1:18000';
const ALPHA = '0b6f5c4e-1a2b-4c3d-8e9f-000000000001';
const ROTATION = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000cc';

type FakeState = {
  customShows: Array<{ id: string; name: string; programs: Array<{ id: string }> }>;
  schedules: Record<string, { slots: Array<Record<string, unknown>> }>;
  saves: number;
};
const fakeState = async (page: Page) => (await (await page.request.get(`${FAKE}/__test/state`)).json()) as FakeState;
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const useRelease = async (page: Page, release: string) => {
  await page.request.post(`${FAKE}/__test/release`, { data: { release } });
  // The companion keeps a check for five minutes; ask for a fresh one.
  await page.request.post('/api/tunarr/compatibility/refresh', { data: {} });
};
/** Opens a menu item by keyboard: focus the menu title, Enter, then arrows to the item. */
async function menu(page: Page, title: string, item: RegExp) {
  await page.getByRole('menuitem', { name: title, exact: true }).focus();
  await page.keyboard.press('Enter');
  const target = page.getByRole('menuitem', { name: item });
  for (let step = 0; step < 30 && !(await target.evaluate((element) => element === document.activeElement)); step += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}
const press = async (page: Page, button: ReturnType<Page['getByRole']>) => {
  await button.focus();
  await page.keyboard.press('Enter');
};

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  await useRelease(page, '2026.10.4');
  const drafts = (await (await page.request.get('/api/tunarr/drafts')).json()) as Array<{ channelId: string }>;
  for (const draft of drafts) await page.request.delete(`/api/tunarr/drafts/${draft.channelId}`);
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
});

test.afterEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  await page.request.post('/api/tunarr/compatibility/refresh', { data: {} });
});

test('Tunarr 2026.10.4 counts as validated, with only movie slots turned off', async ({ page }) => {
  await menu(page, 'Setup', /Server Settings/);
  const settings = page.getByRole('dialog', { name: 'Server settings' });
  await expect(settings.getByText('Tunarr 2026.10.4', { exact: false }).first()).toBeVisible();
  await expect(settings.getByText(/not validated/)).toHaveCount(0);
  await expect(settings.getByRole('button', { name: /^Slot schedules: Limited/ })).toBeVisible();
  await expect(settings.getByRole('button', { name: /^Custom shows: Available/ })).toBeVisible();
  const report = (await (await page.request.get('/api/tunarr/compatibility')).json()) as { version: { status: string }; capabilities: Array<{ id: string; reason: string; parts?: Array<{ id: string; status: string }> }> };
  expect(report.version.status).toBe('validated');
  const slots = report.capabilities.find((item) => item.id === 'slot-schedules')!;
  expect(slots.parts).toEqual([expect.objectContaining({ id: 'movie-slots', status: 'unavailable' })]);
  expect(slots.reason).toContain('“movie” slot type');
  await noOverflow(page);
});

test('a movie slot is refused in plain words, then becomes a custom show only when asked', async ({ page }) => {
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await expect(page.locator('.channel.active')).toContainText('Desk Rotation');
  await press(page, page.getByRole('button', { name: 'Edit slot schedule…' }));
  const dialog = page.getByRole('dialog', { name: /Slot schedule ·/ });
  const warning = dialog.getByRole('alert').filter({ hasText: 'This Tunarr no longer plays movie slots' });
  await expect(warning).toContainText('the custom show “Desk Rotation Movies” with 1 movie (for 1 slot)');
  // "Movies" isn't offered as a new slot, though slot 2 still shows what it is.
  await expect(dialog.getByLabel('Add a slot').locator('option', { hasText: /^Movies$/ })).toHaveCount(0);
  await expect(dialog.getByLabel('Slot 2 source')).toHaveValue('movie');

  // Fits a TV and a laptop without scrolling sideways.
  for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(size);
    await warning.scrollIntoViewIfNeeded();
    await expect(warning.getByRole('button', { name: 'Make the custom show in Tunarr' })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`movie-slots-${size.width}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });

  // Previewing as it is: the companion refuses it before Tunarr, saying what to do.
  await press(page, dialog.getByRole('button', { name: 'Preview lineup' }));
  await expect(dialog.getByRole('alert').filter({ hasText: 'Tunarr didn’t accept this schedule' })).toContainText('no longer plays movie slots');
  expect((await fakeState(page)).customShows).toEqual([]);

  // Asked: the show Tunarr's own upgrade would make, and the slot now plays it.
  await press(page, warning.getByRole('button', { name: 'Make the custom show in Tunarr' }));
  await expect(page.getByText(/Made “Desk Rotation Movies” in Tunarr/)).toBeVisible();
  await expect(warning).toBeHidden();
  const shows = (await fakeState(page)).customShows;
  expect(shows.map(({ name, programs }) => [name, programs.map((program) => program.id)])).toEqual([['Desk Rotation Movies', [ALPHA]]]);
  await expect(dialog.getByLabel('Slot 2 source')).toHaveValue(`custom-show:${shows[0].id}`);
  await expect(dialog.getByLabel('Slot 2 source').locator('option:checked')).toHaveText('Desk Rotation Movies');

  await press(page, dialog.getByRole('button', { name: 'Preview lineup' }));
  await press(page, page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }));
  await expect.poll(async () => (await fakeState(page)).saves).toBe(1);
  const saved = (await fakeState(page)).schedules[ROTATION].slots[1];
  expect(saved).toMatchObject({ id: '9c9c9c9c-1a2b-4c3d-8e9f-000000000002', type: 'custom-show', customShowId: shows[0].id, order: 'shuffle', weight: 1 });
  await noOverflow(page);
});

test('an older Tunarr keeps movie slots', async ({ page }) => {
  await useRelease(page, '1.3.13');
  await page.reload();
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await press(page, page.getByRole('button', { name: 'Edit slot schedule…' }));
  const dialog = page.getByRole('dialog', { name: /Slot schedule ·/ });
  await expect(dialog.getByLabel('Add a slot').locator('option', { hasText: /^Movies$/ })).toHaveCount(1);
  await expect(dialog.getByText('This Tunarr no longer plays movie slots')).toHaveCount(0);
});
