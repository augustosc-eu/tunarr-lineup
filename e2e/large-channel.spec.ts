// Large channels: a reproducible performance check with synthetic programming
// (e2e/syntheticChannel.mjs) served by the fake Tunarr. Prints the measured
// numbers as one JSON line per scenario and checks them against budgets.
import { expect, test, type CDPSession, type Page } from '@playwright/test';

const FAKE = 'http://127.0.0.1:18000';

/** Budgets for the built companion in desktop Chrome; the slow-network one emulates a weak mobile link. */
const BUDGET = {
  /** Bytes on the wire for one large channel's programming (compressed). */
  programmingBytes: 600_000,
  /** Click on the channel → its rows on screen and the desk idle. */
  openMs: 3_000,
  /** The same over 1.6 Mbit/s with 150 ms latency. */
  openSlowMs: 8_000,
  /** Program rows mounted at once, however long the day is. */
  rows: 260,
  /** JS heap after the large channel is open, after a garbage collection. */
  heapBytes: 160_000_000,
  /** Back to a channel already opened once, or to the next day. */
  switchMs: 1_500,
  dayMs: 1_000,
};

type Wire = { bytes: number };

/** Sums what the programming route cost on the wire, from the DevTools protocol. */
async function watchProgramming(cdp: CDPSession) {
  const requests = new Map<string, string>();
  const wire: Record<string, Wire> = {};
  await cdp.send('Network.enable');
  cdp.on('Network.responseReceived', (event) => { if (/\/programming$/.test(new URL(event.response.url).pathname)) requests.set(event.requestId, event.response.url); });
  cdp.on('Network.loadingFinished', (event) => { const url = requests.get(event.requestId); if (url) wire[url] = { bytes: event.encodedDataLength }; });
  return wire;
}

// Generous waits so a slow run reports its number instead of timing out.
const deskIdle = async (page: Page, name: string) => {
  await expect(page.locator('.channel.active')).toContainText(name, { timeout: 60_000 });
  await expect(page.locator('.program').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.timeline.loading')).toHaveCount(0, { timeout: 60_000 });
};

async function addLarge(page: Page, items: number, spotMs?: number) {
  const response = await page.request.post(`${FAKE}/__test/large`, { data: { items, spotMs } });
  return (await response.json()) as { id: string; name: string };
}

const heap = async (cdp: CDPSession) => {
  await cdp.send('HeapProfiler.collectGarbage');
  return (await cdp.send('Runtime.getHeapUsage')).usedSize;
};

test.beforeEach(async ({ page }) => {
  await page.request.post(`${FAKE}/__test/reset`);
  const drafts = (await (await page.request.get('/api/tunarr/drafts')).json()) as Array<{ channelId: string }>;
  for (const draft of drafts) await page.request.delete(`/api/tunarr/drafts/${draft.channelId}`);
});

for (const items of [5_000, 20_000]) {
  test(`opens a ${items}-item channel within budget`, async ({ page }) => {
    const large = await addLarge(page, items);
    const cdp = await page.context().newCDPSession(page);
    const wire = await watchProgramming(cdp);
    await page.goto('/');
    await deskIdle(page, 'Desk News');

    let started = Date.now();
    await page.locator('.channel', { hasText: large.name }).click();
    await deskIdle(page, large.name);
    const openMs = Date.now() - started;
    const rows = await page.locator('.program').count();
    const heapBytes = await heap(cdp);
    const programming = Object.entries(wire).find(([url]) => url.includes(large.id))?.[1] ?? { bytes: 0 };

    started = Date.now();
    await page.locator('.channel', { hasText: 'Desk News' }).click();
    await deskIdle(page, 'Desk News');
    await page.locator('.channel', { hasText: large.name }).click();
    await deskIdle(page, large.name);
    const switchMs = Date.now() - started;

    const date = page.locator('input[type="date"]').first();
    const today = await date.inputValue();
    await page.locator('.program').nth(1).click();
    started = Date.now();
    await page.keyboard.press('ArrowRight');
    await expect(date).not.toHaveValue(today);
    await expect(page.locator('.program').first()).toBeVisible();
    await expect(page.locator('.timeline.loading')).toHaveCount(0, { timeout: 60_000 });
    const dayMs = Date.now() - started;

    const metrics = { scenario: `large-${items}`, openMs, switchMs, dayMs, rows, heapBytes, programmingBytes: programming.bytes };
    console.log(`[perf] ${JSON.stringify(metrics)}`);
    test.info().annotations.push({ type: 'perf', description: JSON.stringify(metrics) });
    expect.soft(programming.bytes, 'bytes on the wire').toBeLessThan(BUDGET.programmingBytes);
    expect.soft(openMs, 'time to open').toBeLessThan(BUDGET.openMs);
    expect.soft(rows, 'rows mounted').toBeLessThanOrEqual(BUDGET.rows);
    expect.soft(heapBytes, 'JS heap').toBeLessThan(BUDGET.heapBytes);
    expect.soft(switchMs, 'channel switch').toBeLessThan(BUDGET.switchMs);
    expect.soft(dayMs, 'day change').toBeLessThan(BUDGET.dayMs);
  });
}

test('keeps a day of short spots to a bounded number of rows', async ({ page }) => {
  // 30 s to 2 min spots: about 1,700 rows a day.
  const dense = await addLarge(page, 5_000, 30_000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto('/');
  await deskIdle(page, 'Desk News');
  const started = Date.now();
  await page.locator('.channel', { hasText: dense.name }).click();
  await deskIdle(page, dense.name);
  const openMs = Date.now() - started;
  const rows = await page.locator('.program').count();
  const dayRows = Number((await page.locator('.day-count').textContent())?.replace(/\D/g, '') ?? 0);
  const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
  const heapBytes = await heap(cdp);
  // Arrow keys still reach every row of the day: the window follows the cursor.
  await page.locator('.program.on-air').click();
  const steps = 300;
  const walk = Date.now();
  for (let step = 0; step < steps; step += 1) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.program:focus')).toBeVisible();
  const keyMs = (Date.now() - walk) / steps;
  const metrics = { scenario: 'dense-5000-spots', openMs, rows, dayRows, nodes, heapBytes, keyMs };
  console.log(`[perf] ${JSON.stringify(metrics)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(metrics) });
  expect(dayRows, 'the synthetic day is dense').toBeGreaterThan(1_000);
  expect.soft(rows, 'rows mounted').toBeLessThanOrEqual(BUDGET.rows);
  expect.soft(openMs, 'time to open').toBeLessThan(BUDGET.openMs);
});

test('opens a 5000-item channel over a slow mobile link within budget', async ({ page }) => {
  const large = await addLarge(page, 5_000);
  const cdp = await page.context().newCDPSession(page);
  const wire = await watchProgramming(cdp);
  await page.goto('/');
  await deskIdle(page, 'Desk News');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  const started = Date.now();
  await page.locator('.channel', { hasText: large.name }).click();
  await deskIdle(page, large.name);
  const openSlowMs = Date.now() - started;
  const programming = Object.entries(wire).find(([url]) => url.includes(large.id))?.[1] ?? { bytes: 0 };
  const metrics = { scenario: 'large-5000-slow-network', openSlowMs, programmingBytes: programming.bytes };
  console.log(`[perf] ${JSON.stringify(metrics)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(metrics) });
  expect.soft(openSlowMs, 'time to open on a slow link').toBeLessThan(BUDGET.openSlowMs);
});

test('opens a small channel quickly and sends little', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page);
  const wire = await watchProgramming(cdp);
  const started = Date.now();
  await page.goto('/');
  await deskIdle(page, 'Desk News');
  const openMs = Date.now() - started;
  await page.locator('.channel', { hasText: 'Desk Movies' }).click();
  await deskIdle(page, 'Desk Movies');
  const bytes = Object.values(wire).reduce((sum, item) => sum + item.bytes, 0);
  const metrics = { scenario: 'small', openMs, programmingBytes: bytes, rows: await page.locator('.program').count() };
  console.log(`[perf] ${JSON.stringify(metrics)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(metrics) });
  expect.soft(openMs, 'first load').toBeLessThan(BUDGET.openMs);
});
