import { expect, test, type Page } from '@playwright/test';

// View → Appearance…: the four skins, checked through computed styles so the
// [data-skin] tokens are really in force, not just stored.
const FAKE = 'http://127.0.0.1:18000';
const KEY = 'tunarr-lineup-skin';
const SKINS = ['platinum', 'windows', 'modern', 'broadcast'] as const;
type SkinId = (typeof SKINS)[number];
const NAMES: Record<SkinId, string> = { platinum: 'Platinum', windows: 'Classic Windows', modern: 'Modern Studio', broadcast: 'Broadcast Console' };
/** What each skin paints: the desktop, the selection, the cable guide's focused cell and the remote's edge. */
const LOOK: Record<SkinId, { desktop: string; selection: string; cableFocus: string; remoteEdge: string; osd: string; scheme: string }> = {
  platinum: { desktop: 'rgb(99, 127, 172)', selection: 'rgb(50, 60, 141)', cableFocus: 'rgb(255, 242, 122)', remoteEdge: 'rgb(17, 17, 17)', osd: 'rgb(125, 255, 107)', scheme: 'normal' },
  windows: { desktop: 'rgb(0, 128, 128)', selection: 'rgb(0, 0, 128)', cableFocus: 'rgb(192, 192, 192)', remoteEdge: 'rgb(0, 0, 0)', osd: 'rgb(125, 255, 107)', scheme: 'normal' },
  modern: { desktop: 'rgb(233, 237, 242)', selection: 'rgb(47, 91, 211)', cableFocus: 'rgb(47, 91, 211)', remoteEdge: 'rgb(211, 217, 226)', osd: 'rgb(125, 255, 107)', scheme: 'normal' },
  broadcast: { desktop: 'rgb(11, 13, 16)', selection: 'rgb(14, 107, 128)', cableFocus: 'rgb(34, 211, 238)', remoteEdge: 'rgb(61, 70, 83)', osd: 'rgb(34, 211, 238)', scheme: 'dark' },
};

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const style = (page: Page, selector: string, property: string) => page.locator(selector).first().evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
const skinOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.skin);
const stored = (page: Page) => page.evaluate((key) => localStorage.getItem(key), KEY);

const openDesk = async (page: Page) => {
  await page.goto('/');
  await expect(page.locator('.channel.active')).toContainText('Desk News');
  await expect(page.locator('.program').first()).toBeVisible();
};
const openAppearance = async (page: Page) => {
  await page.getByRole('menuitem', { name: 'View' }).click();
  await page.getByRole('menuitem', { name: 'Appearance…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Appearance' });
  await expect(dialog).toBeVisible();
  return dialog;
};

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  const drafts = (await (await page.request.get('/api/tunarr/drafts')).json()) as Array<{ channelId: string }>;
  for (const draft of drafts) await page.request.delete(`/api/tunarr/drafts/${draft.channelId}`);
});

test('picks each skin with the keyboard, saves it at once and keeps it after Done and a reload', async ({ page }) => {
  const origins = new Set<string>();
  const violations: string[] = [];
  page.on('request', (request) => origins.add(new URL(request.url()).origin));
  page.on('console', (message) => { if (/Content Security Policy|Refused to/.test(message.text())) violations.push(message.text()); });
  await openDesk(page);
  expect(await skinOf(page)).toBe('platinum');
  expect(await style(page, 'body', 'background-color')).toBe(LOOK.platinum.desktop);

  const dialog = await openAppearance(page);
  const radios = dialog.getByRole('radio');
  await expect(radios).toHaveCount(4);
  await expect(radios.nth(0)).toBeFocused();
  for (const [index, skin] of SKINS.entries()) {
    if (index > 0) {
      // Arrows only move focus; Enter/OK (or Space) picks.
      await page.keyboard.press('ArrowRight');
      await expect(radios.nth(index)).toBeFocused();
      expect(await skinOf(page)).toBe(SKINS[index - 1]);
      await page.keyboard.press(index % 2 ? 'Enter' : 'Space');
    }
    await expect(radios.nth(index)).toHaveAttribute('aria-checked', 'true');
    expect(await skinOf(page)).toBe(skin);
    // Nothing is stored until a skin is picked.
    expect(await stored(page)).toBe(index ? skin : null);
    expect(await style(page, 'body', 'background-color')).toBe(LOOK[skin].desktop);
    expect(await style(page, 'html', 'color-scheme')).toBe(LOOK[skin].scheme);
    // A card reached with the keyboard shows a visible ring (the first was focused after a click).
    if (index) expect(await radios.nth(index).evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe('none');
  }
  // Back to Classic Windows, then Tab to Done and close with Enter.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  expect(await skinOf(page)).toBe('windows');
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  expect(await style(page, '.program', 'border-bottom-color')).not.toBe('');

  await page.reload();
  await expect(page.locator('.program').first()).toBeVisible();
  expect(await skinOf(page)).toBe('windows');
  expect(await style(page, '.workspace', 'background-color')).toBe('rgb(192, 192, 192)');
  expect(violations).toEqual([]);
  expect([...origins]).toEqual(['http://127.0.0.1:13000']);
});

test('applies the saved skin before React runs, and ignores an unknown one', async ({ page }) => {
  await page.addInitScript((key) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem(key, 'broadcast'); sessionStorage.setItem('seeded', '1'); } }, KEY);
  // With the app bundle blocked, only public/skin-init.js can set the skin.
  await page.route('**/assets/*.js', (route) => route.abort());
  await page.goto('/');
  expect(await skinOf(page)).toBe('broadcast');
  expect(await style(page, 'body', 'background-color')).toBe(LOOK.broadcast.desktop);
  await page.evaluate((key) => localStorage.setItem(key, 'neon'), KEY);
  await page.reload();
  expect(await skinOf(page)).toBe('platinum');
  expect(await style(page, 'body', 'background-color')).toBe(LOOK.platinum.desktop);
});

test('Escape closes Appearance without undoing the pick, and the desk keys work again', async ({ page }) => {
  await openDesk(page);
  const dialog = await openAppearance(page);
  await dialog.getByRole('radio', { name: /Modern Studio/ }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await skinOf(page)).toBe('modern');
  expect(await stored(page)).toBe('modern');
  await page.locator('.program').first().click();
  expect(await style(page, '.program.selected', 'background-color')).toBe(LOOK.modern.selection);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard & remote shortcuts' })).toBeVisible();
});

for (const skin of SKINS) {
  test(`${NAMES[skin]}: the desk, Guide Grid, Week View and Watch Live with its cable guide, OSD and remote`, async ({ page }) => {
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [KEY, skin]);
    await openDesk(page);
    expect(await skinOf(page)).toBe(skin);
    await page.locator('.program').first().click();
    expect(await style(page, '.program.selected', 'background-color')).toBe(LOOK[skin].selection);
    expect(await overflow(page)).toBeLessThanOrEqual(0);

    // The guide grid still moves with the arrows.
    await page.locator('.program.on-air').focus();
    await page.keyboard.press('g');
    const grid = page.getByRole('grid', { name: 'Program guide' });
    await expect(grid.locator('.guide-cell.focused')).toHaveCount(1);
    const before = await grid.locator('.guide-cell.focused').getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => grid.locator('.guide-cell.focused').getAttribute('aria-label')).not.toBe(before);
    expect(await style(page, '.guide-cell.focused', 'background-color')).toBe(LOOK[skin].selection);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');

    await page.locator('.program.on-air').focus();
    await page.keyboard.press('w');
    await expect(page.getByRole('grid', { name: 'Week' })).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');

    await page.locator('.program.on-air').focus();
    await page.keyboard.press('l');
    const watch = page.getByRole('dialog', { name: /CH \d+ Desk News/ });
    await expect(watch).toBeVisible();
    const remote = page.getByRole('complementary', { name: 'Remote control' });
    await expect(remote).toBeVisible();
    expect(await style(page, '.tv-remote', 'border-top-color')).toBe(LOOK[skin].remoteEdge);
    // Mute shows the on-screen display.
    await page.keyboard.press('m');
    await expect(page.locator('.tv-osd')).toBeVisible();
    expect(await style(page, '.tv-osd', 'color')).toBe(LOOK[skin].osd);
    await page.keyboard.press('m');

    await page.keyboard.press('g');
    const guide = page.getByRole('grid', { name: 'Cable guide' });
    await expect(guide).toBeVisible();
    await expect(guide.locator('.cable-cell.focused')).toHaveCount(1);
    expect(await style(page, '.cable-cell.focused', 'background')).toContain(LOOK[skin].cableFocus);
    const focusedRow = () => guide.locator('.cable-row.focus-row .cable-channel').textContent();
    const row = await focusedRow();
    await page.keyboard.press('ArrowDown');
    await expect.poll(focusedRow).not.toBe(row);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
    await expect(guide).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(watch).toBeHidden();
  });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('reaches Appearance from the Menu sheet and fits the screen in every skin', async ({ page }) => {
    await openDesk(page);
    await page.getByRole('menuitem', { name: 'Menu' }).click();
    const view = page.getByRole('menu', { name: 'All menus' }).getByRole('group', { name: 'View' });
    await view.getByRole('menuitem', { name: 'Appearance…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Appearance' });
    await expect(dialog).toBeVisible();
    for (const skin of SKINS) {
      await dialog.getByRole('radio', { name: new RegExp(NAMES[skin]) }).tap();
      expect(await skinOf(page)).toBe(skin);
      expect(await style(page, 'body', 'background-color')).toBe(LOOK[skin].desktop);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    }
    await dialog.getByRole('button', { name: 'Done' }).tap();
    await expect(dialog).toBeHidden();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
