import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Compatibility (Server Settings), the Control Room, batch operations and
// media repair, against the built companion and the fake Tunarr. Everything
// is driven by keyboard, as with a TV remote.
const FAKE = 'http://127.0.0.1:18000';

const clearSharedDrafts = async (page: Page) => {
  const drafts = (await (await page.request.get('/api/tunarr/drafts')).json()) as Array<{ channelId: string }>;
  for (const draft of drafts) await page.request.delete(`/api/tunarr/drafts/${draft.channelId}`);
};
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
const missingRoutes = (page: Page, routes: string[]) => page.request.post(`${FAKE}/__test/missing-routes`, { data: { routes } });
/** Opens a menu item by keyboard: focus the menu title, Enter, then arrows to the item. */
async function menu(page: Page, title: string, item: RegExp) {
  await page.getByRole('menuitem', { name: title, exact: true }).focus();
  await page.keyboard.press('Enter');
  const target = page.getByRole('menuitem', { name: item });
  for (let step = 0; step < 30 && !(await target.evaluate((element) => element === document.activeElement)); step += 1) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
}

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  // A fresh compatibility check for every test (the companion keeps one for five minutes).
  await page.request.post('/api/tunarr/compatibility/refresh', { data: {} });
  await clearSharedDrafts(page);
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
  await expect(page.locator('.program').first()).toBeVisible();
});

test.afterEach(async ({ page }) => {
  await missingRoutes(page, []);
  await page.request.post('/api/tunarr/compatibility/refresh', { data: {} });
  // Batches keep snapshots; leave none behind for later specs (an identical snapshot is never taken twice).
  const channels = (await (await page.request.get('/api/tunarr/channels')).json()) as Array<{ id: string }>;
  for (const channel of channels) {
    const list = (await (await page.request.get(`/api/tunarr/channels/${channel.id}/snapshots`)).json()) as Array<{ id: string }>;
    for (const snapshot of list) await page.request.delete(`/api/tunarr/channels/${channel.id}/snapshots/${snapshot.id}`);
  }
});

test('Server Settings shows what this Tunarr can do and exports diagnostics without secrets', async ({ page }) => {
  await menu(page, 'Setup', /Server Settings/);
  const dialog = page.getByRole('dialog', { name: 'Server settings' });
  await expect(dialog.getByText('Tunarr 1.3.13', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Saving lineups: Available/ })).toBeVisible();
  // The fake Tunarr is streaming Desk News, which proves HLS without starting a stream.
  await expect(dialog.getByRole('button', { name: /^Live streams \(HLS\): Available. 1 live stream/ })).toBeVisible();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export diagnostics' }).click();
  const file = await readFile((await (await download).path())!, 'utf8');
  expect(JSON.parse(file)).toMatchObject({ format: 'tunarr-lineup-diagnostics', connected: true, tunarrVersion: { tunarr: '1.3.13' } });
  expect(file).not.toContain('127.0.0.1');
  expect(file).not.toContain('18000');
  expect(file).not.toContain('e2e-password');
  expect(file).not.toContain('7.1-fake');
  await noOverflow(page);
});

test('a manager whose writes this Tunarr lacks keeps reading, and turns off just those actions', async ({ page }) => {
  // The description lists GET /api/filler-lists and POST, but not PUT or DELETE on a list.
  await missingRoutes(page, ['/api/filler-lists/*']);
  await menu(page, 'Setup', /Server Settings/);
  const settings = page.getByRole('dialog', { name: 'Server settings' });
  await settings.getByRole('button', { name: 'Check again' }).click();
  await expect(settings.getByRole('button', { name: /^Filler lists: Limited/ })).toBeVisible();
  await expect(settings.getByText('Partly turned off')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
  await menu(page, 'Lists', /^Filler Lists/);
  const lists = page.getByRole('dialog', { name: /Filler lists/ });
  await expect(lists.getByRole('note')).toContainText('deleting filler lists');
  await expect(lists.getByRole('button', { name: /^New / })).toBeEnabled();
  await lists.getByRole('option').first().focus();
  await page.keyboard.press('Enter');
  await expect(lists.getByRole('button', { name: 'Delete…' })).toBeDisabled();
  await expect(lists.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await noOverflow(page);
});

test('a feature this Tunarr lacks is refused with the reason; the rest keeps working', async ({ page }) => {
  await missingRoutes(page, ['/api/guide/channels']);
  await menu(page, 'Setup', /Server Settings/);
  const dialog = page.getByRole('dialog', { name: 'Server settings' });
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.getByRole('button', { name: /^Guide: Not available/ })).toBeVisible();
  await expect(dialog.getByText('Turned off in the desk')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('g');
  await expect(page.getByRole('status').filter({ hasText: 'Guide isn’t available on this Tunarr' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Program guide' })).toHaveCount(0);
  // Week view doesn't depend on the guide route.
  await page.keyboard.press('w');
  await expect(page.getByRole('grid', { name: 'Week' })).toBeVisible();
});

test('the Control Room works by remote: move, check, filter and act on a channel', async ({ page }) => {
  const origins = new Set<string>();
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('o');
  const room = page.getByRole('dialog', { name: 'Control Room' });
  const list = room.getByRole('list', { name: 'Channels' });
  await expect(list.getByRole('button')).toHaveCount(3);
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^CH 5 Desk News: Not checked/);
  // Viewer counts come through, without who is watching.
  await expect(room.getByRole('button', { name: 'Watched (1)' })).toBeVisible();
  expect(await page.content()).not.toContain('10.9.8.7');
  await noOverflow(page);

  // A: check every channel. Desk News has flex time and no filler lists.
  await page.keyboard.press('a');
  await expect(list.getByRole('button', { name: /^CH 5 Desk News: Warning/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /^CH 9 Desk Movies: Healthy/ })).toBeVisible();
  await expect(room.getByRole('list', { name: 'Findings' })).toContainText('flex time with no filler');

  // F → Errors (none), F → Warnings (Desk News).
  await page.keyboard.press('f');
  await expect(room.getByText('No channels match “Errors”.')).toBeVisible();
  await page.keyboard.press('f');
  await expect(list.getByRole('button')).toHaveCount(1);
  await page.keyboard.press('f');
  await page.keyboard.press('f');
  await page.keyboard.press('f');
  await expect(list.getByRole('button')).toHaveCount(3);

  // ↓ to Desk Movies, OK opens its actions, OK on "Open in the desk".
  await page.keyboard.press('ArrowDown');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^CH 9 Desk Movies/);
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveText('Open in the desk');
  await page.keyboard.press('Enter');
  await expect(room).toBeHidden();
  await expect(page.locator('.channel.active')).toContainText('Desk Movies');
  expect([...origins]).toEqual(['http://127.0.0.1:13000']);
});

test('the Control Room opens a channel’s lineup check and steps back with Back', async ({ page }) => {
  await page.locator('.program.on-air').focus();
  await page.keyboard.press('o');
  const room = page.getByRole('dialog', { name: 'Control Room' });
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^CH 5 Desk News/);
  await page.keyboard.press('PageDown');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^CH 12 Desk Rotation/);
  await page.keyboard.press('Enter');
  await expect(page.locator(':focus')).toHaveText('Open in the desk');
  await page.keyboard.press('Escape');
  await expect(page.locator(':focus')).toHaveAttribute('aria-label', /^CH 12 Desk Rotation/);
  await page.keyboard.press('ArrowRight');
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown');
  await expect(page.locator(':focus')).toHaveText('Check lineup');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Check lineup' })).toBeVisible();
  await expect(page.locator('.channel.active')).toContainText('Desk Rotation');
  await expect(room).toBeHidden();
});

test('the Control Room fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.program').first()).toBeVisible();
  await page.locator('.program').first().focus();
  await page.keyboard.press('o');
  const room = page.getByRole('dialog', { name: 'Control Room' });
  await expect(room.getByRole('list', { name: 'Channels' }).getByRole('button')).toHaveCount(3);
  await noOverflow(page);
});

type FakeState = { channels: Array<{ id: string; number: number; groupTitle?: string }>; lineups: Record<string, Array<{ type: string; id?: string; duration: number }>> };
const fakeState = async (page: Page) => (await (await page.request.get(`${FAKE}/__test/state`)).json()) as FakeState;
const NEWS = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa';
const MOVIES = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000bb';
const CHARLIE = '0b6f5c4e-1a2b-4c3d-8e9f-000000000003';
/** Moves the focus with ↓ until `target` has it (the dialogs' D-pad navigation). */
async function arrowTo(page: Page, target: ReturnType<Page['getByRole']>) {
  for (let step = 0; step < 60 && !(await target.evaluate((element) => element === document.activeElement)); step += 1) await page.keyboard.press('ArrowDown');
  await expect(target).toBeFocused();
}

test('a batch group change is previewed, applied channel by channel, and rolled back by choice', async ({ page }) => {
  await menu(page, 'Channel', /Batch Operations/);
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  await arrowTo(page, dialog.getByRole('radio', { name: /Change group title/ }));
  await page.keyboard.press('Enter');
  await arrowTo(page, dialog.getByRole('button', { name: 'All', exact: true }));
  await page.keyboard.press('Enter');
  await dialog.getByRole('textbox', { name: 'Group title', exact: true }).fill('Desk Network');
  await dialog.getByRole('button', { name: 'Preview' }).focus();
  await page.keyboard.press('Enter');
  const rows = dialog.getByRole('list', { name: 'Changes per channel' });
  await expect(rows.getByText('Group: “tunarr” → “Desk Network”')).toHaveCount(3);
  await noOverflow(page);
  expect((await fakeState(page)).channels.every((channel) => channel.groupTitle !== 'Desk Network')).toBe(true);

  await dialog.getByRole('button', { name: 'Apply to 3 channels…' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.getByText('Save 3 channels in Tunarr?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply to 3 channels' }).focus();
  await page.keyboard.press('Enter');
  const report = dialog.getByRole('list', { name: 'Result per channel' });
  await expect(report.getByText('Saved', { exact: true })).toHaveCount(3);
  expect((await fakeState(page)).channels.map((channel) => channel.groupTitle)).toEqual(['Desk Network', 'Desk Network', 'Desk Network']);

  await report.getByRole('checkbox', { name: 'Roll back CH 9 Desk Movies' }).check();
  await dialog.getByRole('button', { name: 'Roll back 1 channel' }).click();
  await expect(report.getByText('Rollback: Back to how it was.')).toBeVisible();
  expect((await fakeState(page)).channels.map((channel) => channel.groupTitle)).toEqual(['Desk Network', 'tunarr', 'Desk Network']);

  // The record is kept as an audit.
  await dialog.getByRole('button', { name: 'Recent batches' }).click();
  await expect(dialog.getByRole('list', { name: 'Recent batches' })).toContainText('Group → “Desk Network” on 3 channels');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('missing media is found across channels and repaired only as previewed', async ({ page }) => {
  await page.request.post(`${FAKE}/__test/forget-program`, { data: { id: CHARLIE } });
  await menu(page, 'Channel', /Repair Missing Media/);
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  await dialog.getByRole('button', { name: 'All', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const choice = dialog.getByRole('combobox', { name: `What to do with the missing program ${CHARLIE}` });
  await expect(choice).toBeVisible();
  await expect(dialog.getByText(/CH 5 Desk News at #5.*CH 9 Desk Movies at #2/)).toBeVisible();
  // The slot-scheduled channel is never given a manual lineup.
  await expect(dialog.getByRole('list', { name: 'Changes per channel' })).toContainText('generated from a slot schedule');
  await choice.selectOption('flex');
  await expect(dialog.getByRole('button', { name: /Apply to/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Update preview with these choices' }).click();
  await expect(dialog.getByRole('button', { name: 'Apply to 2 channels…' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Apply to 2 channels…' }).click();
  await dialog.getByRole('button', { name: 'Apply to 2 channels' }).click();
  await expect(dialog.getByRole('list', { name: 'Result per channel' }).getByText('Saved', { exact: true })).toHaveCount(2);
  const state = await fakeState(page);
  expect(state.lineups[NEWS].some((item) => item.id === CHARLIE)).toBe(false);
  expect(state.lineups[NEWS][4]).toEqual({ type: 'flex', duration: 25 * 60_000 });
  // Everything else is untouched, Tunarr's own fields included.
  expect(state.lineups[NEWS][2]).toMatchObject({ type: 'content', persisted: true, startOffsetMs: 0 });
  // A snapshot of the lineup as it was is kept first (an identical earlier one is reused, not duplicated).
  const snapshots = (await (await page.request.get(`/api/tunarr/channels/${NEWS}/snapshots`)).json()) as Array<{ id: string }>;
  const newest = (await (await page.request.get(`/api/tunarr/channels/${NEWS}/snapshots/${snapshots[0].id}`)).json()) as { lineup: Array<{ id?: string }> };
  expect(newest.lineup.some((item) => item.id === CHARLIE)).toBe(true);
});

test('a programming package exports without secrets and imports onto another channel', async ({ page }) => {
  await menu(page, 'File', /Export Programming Package/);
  const dialog = page.getByRole('dialog', { name: 'Batch operations' });
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export 1 channel' }).click();
  const file = (await (await download).path())!;
  const text = await readFile(file, 'utf8');
  expect(JSON.parse(text)).toMatchObject({ format: 'tunarr-lineup-package', version: 1, channels: [{ id: NEWS }] });
  expect(text).not.toMatch(/10\.9\.9\.9|secret-token|127\.0\.0\.1/);

  await dialog.getByRole('radio', { name: /Import a programming package/ }).check();
  await dialog.getByLabel('Package file').setInputFiles(file);
  await dialog.getByRole('combobox', { name: 'Put CH 5 Desk News on' }).selectOption(MOVIES);
  await dialog.getByRole('button', { name: 'Preview' }).click();
  await expect(dialog.getByRole('list', { name: 'Changes per channel' })).toContainText('2 → 6 items');
  await dialog.getByRole('button', { name: 'Apply to 1 channel…' }).click();
  await dialog.getByRole('button', { name: 'Apply to 1 channel' }).click();
  await expect(dialog.getByRole('list', { name: 'Result per channel' }).getByText('Saved', { exact: true })).toHaveCount(1);
  const state = await fakeState(page);
  expect(state.lineups[MOVIES]).toEqual(state.lineups[NEWS]);
});

test('the schedule library and calendar: save the desk’s lineup, repeat it every year, refuse an overlap', async ({ page }) => {
  await menu(page, 'File', /Save to Schedule Library/);
  const dialog = page.getByRole('dialog', { name: 'Schedule library & calendar' });
  await dialog.getByLabel('Schedule name').fill('Halloween night');
  await dialog.getByRole('button', { name: 'Save to the library' }).click();
  const saved = dialog.getByRole('list', { name: 'Saved schedules' });
  await expect(saved.getByText('Halloween night')).toBeVisible();
  await saved.getByRole('button', { name: 'Add to calendar…' }).focus();
  await page.keyboard.press('Enter');
  await dialog.getByRole('checkbox', { name: /CH 5 Desk News/ }).focus();
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Check' }).click();
  await expect(dialog.getByRole('list', { name: 'Next occurrences' })).toContainText('31 Oct');
  await dialog.getByRole('button', { name: 'Save to the calendar' }).click();
  const entries = dialog.getByRole('list', { name: 'Calendar entries' });
  await expect(entries).toContainText('Every year, 31 October 18:00 → 1 November 06:00');
  await noOverflow(page);

  // Same channel, same days, same priority: refused before it can be saved.
  await dialog.getByRole('button', { name: /^Library/ }).click();
  await dialog.getByRole('button', { name: 'Add to calendar…' }).click();
  await dialog.getByLabel('Entry name').fill('Clash');
  await dialog.getByRole('checkbox', { name: /CH 5 Desk News/ }).check();
  await dialog.getByRole('button', { name: 'Check' }).click();
  await expect(dialog.getByRole('list', { name: 'Conflicts' })).toContainText('overlaps “Halloween night” (same priority)');
  await expect(dialog.getByRole('button', { name: 'Save to the calendar' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(entries).toBeVisible();

  // Kept by the companion: it's there after a reload, and removing it works.
  await page.reload();
  await menu(page, 'File', /Schedule Library & Calendar/);
  const reopened = page.getByRole('dialog', { name: 'Schedule library & calendar' });
  await expect(reopened.getByRole('list', { name: 'Calendar entries' })).toContainText('Halloween night');
  await reopened.getByRole('button', { name: 'Remove' }).click();
  await expect(reopened.getByText('No entries yet.', { exact: false })).toBeVisible();
  await reopened.getByRole('button', { name: /^Library/ }).click();
  await reopened.getByRole('button', { name: 'Delete' }).click();
  await expect(reopened.getByText('Nothing saved yet.', { exact: false })).toBeVisible();
});

test('the advanced planner previews a rotation and saves exactly that lineup from its start time', async ({ page }) => {
  await menu(page, 'Edit', /Advanced Planner/);
  const dialog = page.getByRole('dialog', { name: 'Advanced planner' });
  await expect(dialog.getByRole('button', { name: 'Add a show…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const library = page.getByRole('dialog', { name: 'Add a show to the plan' });
  await library.getByRole('combobox', { name: 'Library', exact: true }).selectOption({ label: 'Shows' });
  await library.getByRole('button', { name: 'Use Rotation Show' }).click();
  await expect(dialog.getByRole('group', { name: /Rotation Show · 2 programs/ })).toBeVisible();
  await dialog.getByLabel('Days to plan').fill('1');
  await dialog.getByLabel('Seed').fill('e2e-seed');
  await dialog.getByRole('button', { name: 'Preview' }).click();
  const airings = dialog.getByRole('list', { name: 'Planned airings' });
  await expect(airings.getByRole('listitem')).toHaveCount(72);
  await expect(dialog.getByText('Preview · seed e2e-seed')).toBeVisible();
  await noOverflow(page);
  await dialog.getByRole('button', { name: 'Save to CH 5…' }).click();
  await dialog.getByRole('button', { name: 'Replace and save to CH 5' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Saved the plan (seed e2e-seed) to CH 5' })).toBeVisible();
  const state = await fakeState(page);
  expect(state.lineups[NEWS]).toHaveLength(72);
  expect(state.lineups[NEWS].every((item) => item.type === 'content' && item.duration === 20 * 60_000)).toBe(true);
});

test('notifications: a write-only webhook, a test that fails cleanly, and loopback always refused', async ({ page }) => {
  await menu(page, 'Setup', /Server Settings/);
  const dialog = page.getByRole('dialog', { name: 'Server settings' });
  const address = dialog.getByLabel('Webhook address');
  await address.fill('http://127.0.0.1:18000/hook');
  await dialog.getByRole('checkbox', { name: /on my private network/ }).check();
  await dialog.getByRole('button', { name: 'Save notifications' }).click();
  await expect(dialog.getByRole('alert')).toContainText('loopback, link-local or otherwise not allowed');
  await dialog.getByRole('checkbox', { name: /on my private network/ }).uncheck();
  await address.fill('https://hooks.example.invalid/secret-topic');
  await dialog.getByRole('button', { name: 'Save notifications' }).click();
  await expect(dialog.getByText('On · hooks.example.invalid')).toBeVisible();
  expect(await page.content()).not.toContain('secret-topic');
  await dialog.getByRole('button', { name: 'Send a test' }).click();
  await expect(dialog.getByText(/Test not delivered: The webhook’s host name didn’t resolve/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Turn off' }).click();
  await expect(dialog.getByText('Notifications are off.')).toBeVisible();
});

test('the guide preview lists Tunarr’s guide, checks it, and downloads an XMLTV preview without addresses', async ({ page }) => {
  await menu(page, 'View', /Guide Preview/);
  const dialog = page.getByRole('dialog', { name: 'Guide preview' });
  await expect(dialog.getByRole('combobox', { name: 'Channel to preview' })).toBeFocused();
  await expect(dialog.getByRole('table', { name: 'Listing' }).getByRole('row').nth(1)).toBeVisible();
  // Desk News has flex time listed under the channel's own name, and no guide title for it.
  await expect(dialog.getByRole('list', { name: 'Guide checks' })).toContainText('Flex time listed with a generic title');
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Download XMLTV preview' }).click();
  const xml = await readFile((await (await download).path())!, 'utf8');
  expect(xml).toContain('<tv generator-info-name="Tunarr Lineup (preview)">');
  expect(xml).toMatch(/<programme start="\d{14} \+0000"/);
  expect(xml).not.toContain('127.0.0.1');
  await noOverflow(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});
