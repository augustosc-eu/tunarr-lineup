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
  await expect(page.locator('.on-air-tag')).toBeVisible();
  // The desk opens with what's on air selected: the inspector shows its time left.
  await expect(page.locator('.on-air-row')).toContainText('left');
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
  await page.locator('.program', { hasText: 'Alpha Hour' }).first().click();
  await page.getByRole('button', { name: 'Move or swap…' }).click();
  await expect(page.getByText('Currently #3 of 6')).toBeVisible();
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
  channels: Array<{ id: string; name: string; number: number; startTime: number; fillerCollections?: unknown[]; transcodeConfigId?: string; streamMode?: string; watermark?: Record<string, unknown> }>;
  smartCollections: Array<{ name: string; filter: unknown }>;
  mediaSources: Array<{ name: string; type: string; uri?: string; accessToken?: string; libraries: Array<{ name: string; enabled: boolean }> }>;
  transcodeConfigs: Array<{ id: string; videoBitRate: number; vaapiDevice: string }>;
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
  await dialog.getByRole('tab', { name: 'Commercials' }).click();
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
  await editor.getByRole('button', { name: 'Options for slot 1' }).click();
  await editor.getByRole('button', { name: 'Add commercials' }).click();
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  await page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');
  const schedule = (await fullState(page)).schedules[NEWS];
  expect(schedule.type).toBe('time');
  expect(schedule.slots).toEqual([expect.objectContaining({ type: 'movie', startTime: 20 * 3_600_000, filler: [{ types: ['pre'], fillerListId: ADS, fillerOrder: 'shuffle_prefer_short' }] })]);
  await expect(page.locator('.warning')).toContainText('time-slot schedule (1 slot)');
});

const ROTATION = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000cc';

test('shows channel logos through the companion, and numbers when there is no usable logo', async ({ page }) => {
  const news = page.locator('.channel', { hasText: 'Desk News' });
  await expect.poll(() => news.locator('.channel-logo img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  expect(await news.locator('.channel-logo img').getAttribute('src')).toMatch(/^\/api\/tunarr\/channels\/[^/]+\/logo\?v=/);
  await expect(page.locator('.channel', { hasText: 'Desk Movies' }).locator('.no-logo')).toHaveText('9');
  // The rotation logo lives on a site that can't be reached, so its number shows instead.
  await expect(page.locator('.channel', { hasText: 'Desk Rotation' }).locator('.no-logo')).toHaveText('12');
  await expect(page.locator('.head-logo img')).toBeVisible();
  expect(await page.content()).not.toContain('host.docker.internal');
});

test('creates, duplicates and deletes channels', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /New Channel/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New channel' });
  await dialog.getByLabel('Channel name').fill('Late Night');
  await expect(dialog.getByLabel('Channel number')).toHaveValue('13');
  await dialog.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('status')).toHaveText('Channel created in Tunarr');
  await expect(page.locator('.channel.active')).toContainText('Late Night');
  await expect(page.locator('.empty')).toBeVisible();

  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Delete Channel/ }).click();
  await page.getByRole('alertdialog', { name: 'Delete CH 13 Late Night?' }).getByRole('button', { name: 'Delete channel' }).click();
  await expect(page.getByRole('status')).toHaveText('Deleted CH 13 Late Night');
  await expect(page.locator('.channel', { hasText: 'Late Night' })).toHaveCount(0);

  await page.locator('.channel', { hasText: 'Desk News' }).click();
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Duplicate Channel/ }).click();
  const copy = page.getByRole('dialog', { name: 'Duplicate channel' });
  await expect(copy.getByLabel('Channel name')).toHaveValue('Desk News (copy)');
  await copy.getByRole('button', { name: 'Duplicate channel' }).click();
  await expect(page.locator('.channel.active')).toContainText('Desk News (copy)');
  await expect(page.locator('.program', { hasText: 'Alpha Hour' }).first()).toBeVisible();
  const channels = (await fullState(page)).channels;
  expect(channels.map((channel) => [channel.name, channel.number])).toEqual([['Desk News', 5], ['Desk Movies', 9], ['Desk Rotation', 12], ['Desk News (copy)', 13]]);
});

test('limits a show slot to some seasons and links two slots', async ({ page }) => {
  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await page.getByRole('button', { name: 'Edit slot schedule…' }).click();
  const editor = page.getByRole('dialog', { name: /Slot schedule ·/ });
  await editor.getByRole('button', { name: 'Duplicate slot 1' }).click();
  await editor.getByRole('button', { name: 'Options for slot 1' }).click();
  await editor.getByLabel('Which seasons').selectOption('except');
  await editor.getByRole('group', { name: 'Seasons' }).getByLabel(/Season 3/).check();
  await editor.getByLabel('Slot 1 shares episodes with').selectOption({ label: 'Share episodes with slot 2' });
  await expect(editor.getByText('Group 1: slots 1, 2 move through one episode list together.')).toBeVisible();
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  await page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');
  const slots = (await fullState(page)).schedules[ROTATION].slots;
  expect(slots[0]).toMatchObject({ type: 'show', seasonExcludeFilter: [3], seasonFilter: [], linkMode: 'continue' });
  expect(slots[1].iterationGroup).toBe(slots[0].iterationGroup);
});

test('creates a smart collection and uses it in a slot', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Lists' }).click();
  await page.getByRole('menuitem', { name: /Smart Collections/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Smart collections' });
  await dialog.getByRole('button', { name: 'New smart collection' }).click();
  await dialog.getByLabel('Collection name').fill('Recent movies');
  await dialog.getByLabel('Rule 1 field').selectOption({ label: 'Added to library' });
  await dialog.getByLabel('Rule 1 amount').fill('3');
  await dialog.getByLabel('Rule 1 unit').selectOption('month');
  await dialog.getByRole('button', { name: 'Create collection' }).click();
  await expect(dialog.getByRole('option', { name: 'Recent movies' })).toBeVisible();
  const [collection] = (await fullState(page)).smartCollections;
  expect(collection.filter).toMatchObject({ type: 'value', fieldSpec: { key: 'addedAt', relativeDate: { op: 'inthelast', amount: 3, unit: 'month' } } });
  await dialog.getByRole('button', { name: 'Done' }).click();

  await page.locator('.channel', { hasText: 'Desk Rotation' }).click();
  await page.getByRole('button', { name: 'Edit slot schedule…' }).click();
  const editor = page.getByRole('dialog', { name: /Slot schedule ·/ });
  await expect(editor.getByLabel('Add a slot').locator('option', { hasText: 'Smart collection: Recent movies' })).toHaveCount(1);
});

test('adds a media source and turns on its library without exposing secrets', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Setup' }).click();
  await page.getByRole('menuitem', { name: /Media Sources/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Media sources' });
  await expect(dialog.getByLabel('Use library Movies')).toBeChecked();
  expect(await dialog.innerText()).not.toMatch(/10\.9\.9\.9|secret/);
  await dialog.getByRole('button', { name: 'Add media source…' }).click();
  await dialog.getByLabel('Source name').fill('Den Plex');
  await dialog.getByLabel('Server address').fill('http://192.168.1.20:32400');
  await dialog.getByLabel('Plex token').fill('abcdef123456');
  await dialog.getByRole('button', { name: 'Add source' }).click();
  await expect(dialog.getByText('Den Plex')).toBeVisible();
  await dialog.getByLabel('Use library TV Shows').check();
  await expect(dialog.getByRole('status')).toContainText('Turned on TV Shows');
  const sources = (await fullState(page)).mediaSources;
  expect(sources[1]).toMatchObject({ name: 'Den Plex', type: 'plex', uri: 'http://192.168.1.20:32400', accessToken: 'abcdef123456', libraries: [{ name: 'TV Shows', enabled: true }] });
  expect(await dialog.innerText()).not.toContain('abcdef123456');
});

test('edits a transcode profile and a channel’s streaming settings', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Setup' }).click();
  await page.getByRole('menuitem', { name: /Transcode Profiles/ }).click();
  const profiles = page.getByRole('dialog', { name: 'Transcode profiles' });
  await profiles.getByLabel('Resolution').selectOption({ label: '720p HD (1280×720)' });
  await profiles.getByLabel('Video bitrate').fill('3500');
  await profiles.getByRole('button', { name: 'Save profile' }).click();
  await expect(profiles.getByRole('status')).toHaveText('Profile saved.');
  const [profile] = (await fullState(page)).transcodeConfigs;
  expect(profile).toMatchObject({ videoBitRate: 3500, resolution: { widthPx: 1280, heightPx: 720 }, vaapiDevice: '/dev/dri/renderD128' });
  await profiles.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Channel Settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Channel settings' });
  await settings.getByRole('tab', { name: 'Streaming' }).click();
  await settings.getByLabel('Stream format').selectOption('mpegts');
  await settings.getByRole('tab', { name: 'Logo & watermark' }).click();
  await expect(settings.locator('.logo-preview img')).toBeVisible();
  await settings.getByLabel('Show a watermark while this channel plays').check();
  await settings.getByLabel('Watermark opacity').fill('60');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toHaveText('Channel settings saved to Tunarr');
  const channel = (await fullState(page)).channels.find((item) => item.id === NEWS)!;
  expect(channel).toMatchObject({ streamMode: 'mpegts', transcodeConfigId: profile.id, watermark: { enabled: true, opacity: 60 } });
});

test('builds a new channel from a programming template, previews and saves it', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Programming Templates/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Programming templates' });
  await dialog.getByLabel('Search templates').fill('HBO');
  await dialog.getByRole('option', { name: /^HBO/ }).click();
  await expect(dialog.getByLabel('Day plan')).toContainText('Premiere movie');
  await expect(dialog.getByLabel('Movie source', { exact: true })).toHaveValue('__suggest__');
  await dialog.getByLabel('Prestige drama source').selectOption('');
  await dialog.getByLabel('Comedy source').selectOption('');
  await dialog.getByLabel('Documentaries source').selectOption('');
  await dialog.getByLabel('Promos list').selectOption({ label: 'Station Ads' });
  await dialog.getByLabel('Use it for').selectOption('new');
  await dialog.getByLabel('New channel name').fill('Cinema Max');
  await dialog.getByRole('button', { name: 'Create 3 smart collections and open the schedule' }).click();

  const editor = page.getByRole('dialog', { name: /New slot schedule · CH 13 Cinema Max/ });
  await expect(editor.getByText(/Time slots, repeating every week/)).toBeVisible();
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  await page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');

  const state = await fullState(page);
  const channel = state.channels.find((item) => item.name === 'Cinema Max')!;
  const schedule = state.schedules[channel.id] as unknown as { period: string; padMs: number; slots: Array<Record<string, unknown>> };
  expect(schedule).toMatchObject({ period: 'week', padMs: 30 * 60_000 });
  expect(state.smartCollections.map((item) => item.name)).toEqual(['HBO · Family movie', 'HBO · Movie', 'HBO · Premiere movie']);
  // Sunday 20:00 falls in the Sunday movies block that starts at 19:00.
  expect(schedule.slots.some((slot) => slot.startTime === 19 * 3_600_000 && slot.type === 'smart-collection')).toBe(true);
  expect(schedule.slots[0]).toMatchObject({ filler: [{ types: ['tail'] }] });
  expect(schedule.slots.every((slot) => slot.midRoll === undefined)).toBe(true);
});

test('asks the AI for a schedule, saves it as a template and applies it', async ({ page }) => {
  await page.getByRole('menuitem', { name: 'Channel' }).click();
  await page.getByRole('menuitem', { name: /Programming Templates/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Programming templates' });
  await dialog.getByRole('button', { name: 'Ask AI…' }).click();
  await expect(dialog.getByText(/OpenAI-compatible API \(fake-model\)/)).toBeVisible();
  await dialog.getByLabel('AI prompt').fill('Evening sitcoms and late movies');
  await dialog.getByRole('button', { name: 'Write the schedule' }).click();
  await expect(dialog.getByText('Built around Rotation Show.')).toBeVisible();
  await expect(dialog.getByLabel('Comedy source')).toHaveValue(`show:7a7a7a7a-1a2b-4c3d-8e9f-0000000000f1`);
  await expect(dialog.getByLabel('Commercials list')).toHaveValue(ADS);
  await dialog.getByRole('button', { name: 'Save to My templates' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved “AI comedy nights” to My templates.');
  await dialog.getByLabel('Template group').selectOption({ label: 'My templates (1)' });
  await expect(dialog.getByRole('option', { name: /AI comedy nights/ })).toBeVisible();
  await dialog.getByRole('button', { name: /open the schedule/ }).click();

  const editor = page.getByRole('dialog', { name: /New slot schedule · CH 5 Desk News/ });
  await editor.getByRole('button', { name: 'Preview lineup' }).click();
  await page.getByRole('region', { name: 'Schedule preview' }).getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByRole('status')).toContainText('Schedule saved');
  const schedule = (await fullState(page)).schedules[NEWS];
  expect(schedule.slots).toEqual([
    expect.objectContaining({ type: 'show', startTime: 18 * 3_600_000, midRoll: expect.objectContaining({ maxBreaks: 2 }), filler: [expect.objectContaining({ fillerListId: ADS, types: ['mid'] })] }),
    expect.objectContaining({ type: 'smart-collection', startTime: 21 * 3_600_000 }),
  ]);
  expect(schedule.slots[1].midRoll).toBeUndefined();
});

test('schedules a movie as an event on a date and keeps the rest on time', async ({ page }) => {
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Schedule an event' });
  // The fake's 2-hour lineup starts on the hour, two hours ago. Placing the event
  // exactly there means the 90-minute movie fits before the cycle ends whatever
  // time the suite runs (a fixed time overran the cycle at odd hours).
  const start = new Date((await fullState(page)).channels.find((channel) => channel.id === NEWS)!.startTime);
  const pad = (value: number) => String(value).padStart(2, '0');
  await dialog.getByLabel('Event date').fill(`${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`);
  await dialog.getByLabel('Event time').fill(`${pad(start.getHours())}:00`);
  await dialog.getByRole('button', { name: 'Choose programs…' }).click();
  const library = page.getByRole('dialog', { name: 'Programs for the event' });
  await library.getByRole('button', { name: 'Add Zulu Dawn (1979)' }).click();
  await library.getByRole('button', { name: /^Use 1/ }).click();
  await expect(dialog.getByRole('status', { name: 'Event placement' })).toContainText('Zulu Dawn:');
  await dialog.getByRole('button', { name: 'Place event' }).click();
  await expect(page.locator('.edit-list')).toContainText('Scheduled “Zulu Dawn”');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toHaveText('Lineup saved to Tunarr');
  const lineup = (await fakeState(page)).lineups[NEWS];
  expect(lineup.some((item) => item.id === '4d4d4d4d-1a2b-4c3d-8e9f-000000000001')).toBe(true);
  // Replace mode keeps the cycle length: two hours before, two hours after.
  const durations = lineup as unknown as Array<{ duration: number }>;
  expect(durations.reduce((sum, item) => sum + item.duration, 0)).toBe(120 * 60_000);
});

test('inserts a movie at a date and time on another day, from the keyboard', async ({ page }) => {
  await page.keyboard.press('i');
  const insert = page.getByRole('dialog', { name: 'Insert into the lineup' });
  await expect(insert.getByRole('status', { name: 'Insert placement' })).toContainText('Starts ');
  await insert.getByRole('radio', { name: 'At a time…' }).click();
  const tomorrow = new Date(Date.now() + 86_400_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`;
  await insert.getByLabel('Insert date').fill(date);
  await insert.getByLabel('Insert time').fill('10:00');
  await expect(insert.getByRole('status', { name: 'Insert placement' })).toContainText(/Starts .*(1[0-3]):\d\d:\d\d/);
  await page.screenshot({ path: test.info().outputPath('insert-at-time.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await insert.getByRole('button', { name: 'Browse library…' }).click();
  const library = page.getByRole('dialog', { name: 'Insert programs' });
  await library.getByRole('button', { name: 'Add Zulu Dawn (1979)' }).click();
  await library.getByRole('button', { name: 'Insert 1' }).click();
  // It starts at the first program boundary at or after 10:00 (when the program on air then ends).
  await expect(page.locator('.edit-list')).toContainText(/Inserted “Zulu Dawn” at (1[0-3]):\d\d:\d\d/);
  await expect(page.locator('.program.cursor')).toContainText('Zulu Dawn');
  await expect(page.getByLabel('Jump to date')).toHaveValue(date);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toHaveText('Lineup saved to Tunarr');
  expect((await fakeState(page)).lineups[NEWS].some((item) => item.id === '4d4d4d4d-1a2b-4c3d-8e9f-000000000001')).toBe(true);
});

test('keeps what is on air in place while inserting, by moving the start time on save', async ({ page }) => {
  // The fake's 2-hour lineup started two hours ago, so it has played through once.
  const startTime = (await fullState(page)).channels.find((channel) => channel.id === NEWS)!.startTime;
  const onAir = page.locator('.program.on-air');
  const before = (await onAir.locator('time').innerText()).slice(0, 8);
  await onAir.click();
  await page.keyboard.press('i');
  const insert = page.getByRole('dialog', { name: 'Insert into the lineup' });
  await insert.getByRole('radio', { name: 'Flex time' }).click();
  await insert.getByLabel(/Keep what’s on air in place/).check();
  await insert.getByRole('button', { name: 'Insert', exact: true }).click();
  await expect(page.locator('.edit-list')).toContainText('Inserted flex time at');
  await expect(onAir.locator('time')).toContainText(before);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('start time moved so what’s on air keeps its time');
  expect((await fullState(page)).channels.find((channel) => channel.id === NEWS)!.startTime).toBe(startTime - 2 * 60_000);
  await page.reload();
  await expect(page.locator('.program.on-air time')).toContainText(before);
});
