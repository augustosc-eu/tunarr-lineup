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
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect(await newsOrder(page)).toEqual(['flex', '2', '1', 'redirect', '3', '4']);

  await page.reload();
  await expect(page.locator('.program').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Move or swap…' }).click();
  await expect(page.getByText('Currently #1 of 6')).toBeVisible();
  expect((await fakeState(page)).saves).toBe(1);
});

test('refuses to overwrite a lineup that changed in Tunarr meanwhile', async ({ page }) => {
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.request.post(`${FAKE}/__test/edit-elsewhere?channel=${NEWS}`);
  await page.getByRole('button', { name: 'Save lineup', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('This channel changed in Tunarr');
  expect((await fakeState(page)).saves).toBe(0);
  await dialog.getByRole('button', { name: 'Reload from Tunarr' }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
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

test('restores unsaved changes and the edit list after a browser reload', async ({ page }) => {
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await expect(page.locator('.edit-list')).toContainText('EDIT LIST (2)');
  await expect(page.locator('.channel.active .unsaved-mark')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Restored your unsaved changes (2 edits)');
  await expect(page.getByRole('button', { name: 'Save lineup', exact: true })).toBeVisible();
  await page.locator('.edit-list').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.edit-list')).toContainText('EDIT LIST (1)');
  expect((await fakeState(page)).saves).toBe(0);
});

test('a second session cannot overwrite a save it has not seen', async ({ page, browser }) => {
  const other = await browser.newPage();
  await other.goto('/');
  await expect(other.locator('.program').first()).toBeVisible();
  // Session 1 saves first.
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.getByRole('button', { name: '↓ Later' }).click();
  await page.getByRole('button', { name: 'Save lineup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  // Session 2 still holds the old version and is refused.
  await other.locator('.program', { hasText: 'Delta Weather' }).first().click();
  await other.getByRole('button', { name: '↑ Earlier' }).click();
  await other.getByRole('button', { name: 'Save lineup', exact: true }).click();
  await expect(other.getByRole('alertdialog')).toContainText('This channel changed in Tunarr');
  expect((await fakeState(page)).saves).toBe(1);
  expect(await newsOrder(page)).toEqual(['flex', '1', '2', 'redirect', '3', '4']);
  await other.close();
});

test('edits a random-slot schedule, previews it, and saves exactly the preview', async ({ page }) => {
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await expect(page.locator('.warning')).toContainText('random-slot schedule (2 slots)');
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Edit Slot Schedule/ }).click();
  const editor = page.getByRole('dialog', { name: /Slot schedule ·/ });
  await expect(editor.getByLabel('Slot 1 source')).toHaveValue(/^show:/);
  await editor.getByLabel('Slot 1 weight').fill('5');
  await expect(editor.getByText('83.3%')).toBeVisible();
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  const preview = page.getByRole('region', { name: 'Schedule preview' });
  await expect(preview).toContainText('Tunarr regenerated 11 lineup items');
  await preview.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');

  const state = (await (await page.request.get(`${FAKE}/__test/state`)).json()) as { schedules: Record<string, { slots: Array<{ weight: number }> }>; lastScheduleSave: { programs: string[]; seed: number[] } };
  const rotation = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000cc';
  expect(state.schedules[rotation].slots.map((slot) => slot.weight)).toEqual([5, 1]);
  expect(state.lastScheduleSave.seed).toEqual([42]);
  // The pool is built by the companion from programs already on the channel.
  expect([...new Set(state.lastScheduleSave.programs)].sort()).toEqual(['0b6f5c4e-1a2b-4c3d-8e9f-000000000001', '0b6f5c4e-1a2b-4c3d-8e9f-0000000000e1', '0b6f5c4e-1a2b-4c3d-8e9f-0000000000e2']);

  await page.reload();
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await page.getByRole('button', { name: 'Edit slot schedule…' }).click();
  await expect(page.getByRole('dialog', { name: /Slot schedule ·/ }).getByLabel('Slot 1 weight')).toHaveValue('5');
});

const ADS = '5e5e5e5e-1a2b-4c3d-8e9f-000000000001';
type FullState = FakeState & {
  fillerLists: Array<{ id: string; name: string; programs: unknown[] }>;
  schedules: Record<string, { type: string; slots: Array<Record<string, unknown>> }>;
  channels: Array<{ id: string; fillerCollections?: unknown[]; transcodeConfigId?: string }>;
};
const fullState = async (page: Page) => (await (await page.request.get(`${FAKE}/__test/state`)).json()) as FullState;

test('inserts a movie from the library, saves it, and it persists', async ({ page }) => {
  const bodies: string[] = [];
  page.on('response', async (response) => { if (response.url().includes('/media-sources')) bodies.push(await response.text()); });
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.keyboard.press('i');
  await page.getByRole('dialog', { name: 'Insert into the lineup' }).getByRole('button', { name: 'Browse library…' }).click();
  const library = page.getByRole('dialog', { name: 'Insert programs' });
  await library.getByLabel('Search the library').fill('zulu');
  await library.getByRole('button', { name: 'Search' }).click();
  await library.getByRole('button', { name: 'Add Zulu Dawn (1979)' }).click();
  await library.getByRole('button', { name: 'Insert 1' }).click();
  await expect(page.locator('.edit-list')).toContainText('Inserted “Zulu Dawn”');
  await page.getByRole('button', { name: 'Save lineup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  expect((await fakeState(page)).lineups[NEWS].slice(0, 2).map((item) => item.id)).toEqual(['0b6f5c4e-1a2b-4c3d-8e9f-000000000001', '4d4d4d4d-1a2b-4c3d-8e9f-000000000001']);
  // Media-server addresses and accounts never reach the browser.
  expect(bodies.join('')).not.toMatch(/10\.9\.9\.9|secret-owner/);
  await page.reload();
  await expect(page.locator('.program', { hasText: 'Zulu Dawn' }).first()).toBeVisible();
});

test('inserts a commercial break that plays a filler list', async ({ page }) => {
  await page.locator('.program', { hasText: 'Bravo Report' }).first().click();
  await page.getByRole('button', { name: 'Insert…' }).click();
  const insert = page.getByRole('dialog', { name: 'Insert into the lineup' });
  await insert.getByRole('radio', { name: 'Commercial break' }).click();
  await insert.getByLabel(/Station Ads/).check();
  await insert.getByLabel('Length minutes').fill('3');
  await insert.getByRole('button', { name: 'Insert' }).click();
  await expect(page.locator('.program', { hasText: 'Commercial break' }).first()).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
  const saved = (await fakeState(page)).lineups[NEWS] as unknown as Array<Record<string, unknown>>;
  expect(saved[3]).toEqual({ type: 'flex', duration: 180000, fillerConfig: { fillerListIds: [ADS], fillerRepeatCooldownMs: 0, origin: 'flex' } });
});

test('creates a filler list from the library', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Lists' }).click();
  await page.getByRole('menuitem', { name: /Filler Lists/ }).click();
  const manager = page.getByRole('dialog', { name: /Filler lists/ });
  await manager.getByRole('button', { name: 'New filler list' }).click();
  await manager.getByLabel('List name').fill('Bumpers');
  await manager.getByRole('button', { name: 'Add programs…' }).click();
  const library = page.getByRole('dialog', { name: 'Add to Bumpers' });
  await library.getByRole('button', { name: 'Add Yankee Doodle Dandy (1942)' }).click();
  await library.getByRole('button', { name: 'Add 1' }).click();
  await manager.getByRole('button', { name: 'Create filler list' }).click();
  await expect(manager.getByRole('option', { name: /Bumpers/ })).toBeVisible();
  const lists = (await fullState(page)).fillerLists;
  expect(lists.map((list) => [list.name, list.programs.length])).toEqual([['Station Ads', 1], ['Bumpers', 1]]);
});

test('sets channel-wide commercials for flex time without touching other channel settings', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Channel Settings/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Channel settings' });
  await dialog.getByRole('button', { name: 'Add filler list' }).click();
  await dialog.getByLabel('Filler list 1 cooldown minutes').fill('10');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Channel settings saved to Tunarr');
  const channel = (await fullState(page)).channels.find((item) => item.id === NEWS)!;
  expect(channel.fillerCollections).toEqual([{ id: ADS, weight: 1, cooldownSeconds: 600 }]);
});

test('creates a time-slot schedule with commercials for a manual channel', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Create Slot Schedule/ }).click();
  const editor = page.getByRole('dialog', { name: /New slot schedule ·/ });
  await editor.getByRole('radio', { name: 'Time slots' }).click();
  await editor.getByLabel('Add a slot').selectOption({ label: 'Movies' });
  await editor.getByLabel('Slot 1 start').fill('20:00:00');
  await editor.getByRole('button', { name: 'Commercials for slot 1' }).click();
  await editor.getByRole('button', { name: 'Add commercials' }).click();
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  await page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');
  const schedule = (await fullState(page)).schedules[NEWS];
  expect(schedule.type).toBe('time');
  expect(schedule.slots).toEqual([expect.objectContaining({ type: 'movie', startTime: 20 * 3_600_000, filler: [{ types: ['pre'], fillerListId: ADS, fillerOrder: 'shuffle_prefer_short' }] })]);
  await expect(page.locator('.warning')).toContainText('time-slot schedule (1 slot)');
});
