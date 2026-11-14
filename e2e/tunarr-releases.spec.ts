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
  const report = (await (await page.request.get('/api/tunarr/compatibility')).json()) as { version: { status: string }; capabilities: Array<{ id: string; reason: string; parts?: Array<{ id: string; status: string; optional?: boolean }> }> };
  expect(report.version.status).toBe('validated');
  const slots = report.capabilities.find((item) => item.id === 'slot-schedules')!;
  // Optional parts (better ways used where Tunarr has them) never turn anything off.
  expect(slots.parts?.filter((part) => !part.optional)).toEqual([expect.objectContaining({ id: 'movie-slots', status: 'unavailable' })]);
  expect(slots.reason).toContain('“movie” slot type');
  await noOverflow(page);
});

test('Tunarr 2026.11.0 counts as validated, and only its version is kept', async ({ page }) => {
  await useRelease(page, '2026.11.0');
  const report = (await (await page.request.get('/api/tunarr/compatibility')).json()) as { version: { tunarr: string; status: string }; capabilities: Array<{ id: string; status: string }> };
  expect(report.version).toMatchObject({ tunarr: '2026.11.0', status: 'validated' });
  expect(JSON.stringify(report)).not.toContain('0.1.0-fake');
  expect(report.capabilities.find((item) => item.id === 'manual-saves')?.status).toBe('available');
  await menu(page, 'Setup', /Server Settings/);
  const settings = page.getByRole('dialog', { name: 'Server settings' });
  await expect(settings.getByText('Tunarr 2026.11.0', { exact: false }).first()).toBeVisible();
  await expect(settings.getByText(/not validated/)).toHaveCount(0);
  await noOverflow(page);
});

test('Tunarr 2026.11.2: subtitles are chosen by profile in Channel Settings, and other settings keep it', async ({ page }) => {
  await useRelease(page, '2026.11.2');
  const report = (await (await page.request.get('/api/tunarr/compatibility')).json()) as { version: { status: string }; capabilities: Array<{ id: string; status: string; parts?: Array<{ id: string; status: string }> }> };
  expect(report.version.status).toBe('validated');
  // The old switch is retired, but Lineup offers what replaced it, so nothing is Limited for it.
  expect(report.capabilities.find((item) => item.id === 'channel-settings')).toMatchObject({ status: 'available', parts: [{ id: 'subtitles', status: 'unavailable' }] });
  await page.reload();
  await expect(page.locator('.channel.active')).toContainText('Desk News');

  await menu(page, 'Channel', /Channel Settings/);
  const settings = page.getByRole('dialog', { name: 'Channel settings' });
  await press(page, settings.getByRole('tab', { name: 'Streaming' }));
  const subtitles = settings.getByLabel('Subtitles', { exact: true });
  await expect(subtitles).toBeEnabled();
  await expect(subtitles.locator('option:checked')).toHaveText('Tunarr’s default (Tunarr Default) · No subtitles');
  await expect(settings.getByRole('checkbox')).toHaveCount(0);
  await subtitles.focus();
  await subtitles.selectOption({ label: 'Spanish subtitles · Subtitles in Spanish' });
  for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(size);
    await noOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`subtitle-profile-${size.width}.png`) });
  }
  await page.setViewportSize({ width: 1920, height: 1080 });
  await press(page, settings.getByRole('button', { name: 'Save settings' }));
  await expect(page.getByRole('status')).toHaveText('Channel settings saved to Tunarr');
  const channelOf = async () => ((await (await page.request.get(`${FAKE}/__test/state`)).json()) as { channels: Array<{ name: string; streamMode?: string; streamSelectionProfileId?: unknown }> }).channels.find((item) => item.name === 'Desk News')!;
  expect(await channelOf()).toMatchObject({ streamSelectionProfileId: '6e6e6e6e-1a2b-4c3d-8e9f-000000000001' });

  // Another setting saved later keeps the profile.
  await menu(page, 'Channel', /Channel Settings/);
  await press(page, settings.getByRole('tab', { name: 'Streaming' }));
  await expect(settings.getByLabel('Subtitles', { exact: true }).locator('option:checked')).toHaveText('Spanish subtitles · Subtitles in Spanish');
  await settings.getByLabel('Stream format').selectOption('mpegts');
  await press(page, settings.getByRole('button', { name: 'Save settings' }));
  await expect(page.getByRole('status')).toHaveText('Channel settings saved to Tunarr');
  expect(await channelOf()).toMatchObject({ streamMode: 'mpegts', streamSelectionProfileId: '6e6e6e6e-1a2b-4c3d-8e9f-000000000001' });
});

test('Tunarr 2026.11.2: Reset removes the slot schedule in place, keeping the channel and its id', async ({ page }) => {
  await useRelease(page, '2026.11.2');
  await page.reload();
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await expect(page.getByText('Generated schedule')).toBeVisible();
  await menu(page, 'Channel', /Reset Channel/);
  const confirm = page.getByRole('alertdialog', { name: 'Reset CH 12 Desk Rotation?' });
  await expect(confirm).toContainText('Tunarr removes the schedule from this channel itself');
  await expect(confirm).not.toContainText('makes a new channel');
  await noOverflow(page);
  await press(page, confirm.getByRole('button', { name: 'Reset and remove schedule' }));
  await expect(page.getByRole('status')).toHaveText('Reset CH 12 Desk Rotation. Its lineup and slot schedule are gone.');
  await expect(page.locator('.channel.active')).toContainText('Desk Rotation');
  const state = (await (await page.request.get(`${FAKE}/__test/state`)).json()) as { channels: Array<{ id: string; name: string; number: number }>; schedules: Record<string, unknown>; lineups: Record<string, unknown[]> };
  expect(state.channels.find((channel) => channel.name === 'Desk Rotation')).toMatchObject({ id: ROTATION, number: 12 });
  expect(state.channels).toHaveLength(3);
  expect(state.schedules[ROTATION]).toBeUndefined();
  expect(state.lineups[ROTATION]).toEqual([]);
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
