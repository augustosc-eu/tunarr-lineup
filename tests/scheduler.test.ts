import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { itemIdentity, programmingVersion } from '../server/lineupVersion';
import { createScheduler, findPatch, validatePlan, type ScheduledChange } from '../server/scheduler';
import { createSnapshotStore } from '../server/snapshotStore';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';

const CHANNEL = 'chan-1';
const A = { type: 'content', id: 'a0000000-0000-4000-8000-000000000001', duration: 1_800_000 };
const B = { type: 'content', id: 'a0000000-0000-4000-8000-000000000002', duration: 1_800_000 };
const C = { type: 'content', id: 'a0000000-0000-4000-8000-000000000003', duration: 1_800_000 };
const EVENT = { type: 'content', id: 'e0000000-0000-4000-8000-000000000001', duration: 3_000_000 };
const PAD = { type: 'flex', duration: 600_000 };

/** A Tunarr that keeps one channel's lineup and records saves. */
async function fakeTunarr(initial: unknown[], options: { schedulerOn?: boolean } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'lineup-scheduler-'));
  const state = { lineup: initial as unknown[], saves: [] as unknown[][] };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/api/channels/${CHANNEL}/programming`) && init?.method === 'POST') {
      state.lineup = (JSON.parse(String(init.body)) as { lineup: unknown[] }).lineup;
      state.saves.push(state.lineup);
      return new Response(JSON.stringify({ lineup: state.lineup }), { status: 200 });
    }
    if (url.endsWith(`/api/channels/${CHANNEL}/programming`)) return new Response(JSON.stringify({ lineup: state.lineup, programs: {} }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
  const config: ProxyConfig = { ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000', LINEUP_DATA_DIR: dataDir, LINEUP_SCHEDULER: options.schedulerOn === false ? 'off' : 'on' }), fetchImpl: fetchImpl as unknown as typeof fetch };
  const snapshots = createSnapshotStore(dataDir);
  config.snapshots = snapshots;
  const scheduler = createScheduler(config, { enabled: options.schedulerOn !== false, dataDir, snapshots });
  config.scheduler = scheduler;
  return { state, config, scheduler, snapshots };
}

const post = (url: string, body: unknown) => ({ method: 'POST', url, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const now = Date.now();

describe('scheduled change plans', () => {
  it('accepts a dated save and refuses times in the past, empty lineups and unknown kinds', () => {
    const save = { channelId: CHANNEL, label: 'Fall lineup', at: now + 60_000, action: { kind: 'lineup', lineup: [A, B], expectVersion: 'abc-def-1' } };
    expect(validatePlan({ group: 'save', changes: [save] }, now, [])).toMatchObject({ group: 'save' });
    expect(validatePlan({ group: 'save', changes: [{ ...save, at: now - 3_600_000 }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'save', changes: [{ ...save, action: { ...save.action, lineup: [] } }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'save', changes: [{ ...save, action: { kind: 'rm -rf' } }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'save', changes: [{ ...save, action: { ...save.action, lineup: [{ type: 'content', duration: 5 }] } }] }, now, [])).toHaveProperty('error');
  });

  it('lets an overlay end restore the change that begins it, in order', () => {
    const begin = { channelId: CHANNEL, label: 'Halloween', at: now + 60_000, action: { kind: 'lineup', lineup: [C], expectVersion: 'v-1-2' } };
    const end = { channelId: CHANNEL, label: 'Halloween ends', at: now + 120_000, action: { kind: 'restore', after: 0 } };
    expect(validatePlan({ group: 'overlay', changes: [begin, end] }, now, [])).toMatchObject({ group: 'overlay' });
    expect(validatePlan({ group: 'overlay', changes: [begin, { ...end, at: now + 30_000 }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'overlay', changes: [end] }, now, [])).toHaveProperty('error');
  });

  it('finds the items a patch replaces where they were, or their only other place', () => {
    const lineup = [A, B, C];
    expect(findPatch(lineup, 1, [itemIdentity(B)])).toBe(1);
    expect(findPatch([C, ...lineup], 1, [itemIdentity(B)])).toBe(2);
    expect(findPatch([B, A, B], 1, [itemIdentity(B)])).toBe(-1);
    expect(findPatch(lineup, 0, [itemIdentity(EVENT)])).toBe(-1);
  });
});

describe('scheduler', () => {
  it('saves a dated lineup when it is due, keeping a snapshot first', async () => {
    const { state, config, scheduler, snapshots } = await fakeTunarr([A, B]);
    const response = await handleTunarrApi(post('/api/tunarr/scheduled', {
      group: 'save', changes: [{ channelId: CHANNEL, label: 'Swap', at: now + 60_000, action: { kind: 'lineup', lineup: [B, A], expectVersion: programmingVersion([A, B], undefined) } }],
    }), config);
    expect(response.status).toBe(201);
    expect(await scheduler.runDue(now)).toBe(0);
    expect(await scheduler.runDue(now + 61_000)).toBe(1);
    expect(state.lineup).toEqual([B, A]);
    const [change] = await scheduler.store.list();
    expect(change).toMatchObject({ status: 'done', appliedVersion: programmingVersion([B, A], undefined) });
    expect((await snapshots.list(CHANNEL))[0]).toMatchObject({ reason: 'Before scheduled change “Swap”', items: 2 });
  });

  it('skips a dated lineup when the channel changed after it was planned', async () => {
    const { state, scheduler } = await fakeTunarr([A, B]);
    await scheduler.store.add({ group: 'save', changes: [{ channelId: CHANNEL, channelName: '', label: 'Old plan', at: now, action: { kind: 'lineup', lineup: [C], expectVersion: 'stale-version-1' }, programs: {} }] });
    await scheduler.runDue(now + 1000);
    expect(state.saves).toHaveLength(0);
    expect((await scheduler.store.list())[0]).toMatchObject({ status: 'skipped' });
  });

  it('airs an event once: puts it in before it starts and takes it out after', async () => {
    const { state, scheduler } = await fakeTunarr([A, B, C]);
    await scheduler.store.add({
      group: 'event',
      changes: [
        { channelId: CHANNEL, channelName: '', label: 'Final', at: now + 1000, action: { kind: 'patch', index: 1, remove: [itemIdentity(B), itemIdentity(C)], insert: [EVENT, PAD] }, programs: {} },
        { channelId: CHANNEL, channelName: '', label: 'Final ends', at: now + 5000, action: { kind: 'patch', index: 1, remove: [itemIdentity(EVENT), itemIdentity(PAD)], insert: [B, C] }, programs: {} },
      ],
    });
    await scheduler.runDue(now + 2000);
    expect(state.lineup).toEqual([A, EVENT, PAD]);
    await scheduler.runDue(now + 6000);
    expect(state.lineup).toEqual([A, B, C]);
  });

  it('runs an overlay and puts the old lineup back at its end, unless the channel was changed meanwhile', async () => {
    const { state, scheduler } = await fakeTunarr([A, B]);
    await scheduler.store.add({
      group: 'overlay',
      changes: [
        { channelId: CHANNEL, channelName: '', label: 'Holidays', at: now + 1000, action: { kind: 'lineup', lineup: [C], expectVersion: programmingVersion([A, B], undefined) }, programs: {} },
        { channelId: CHANNEL, channelName: '', label: 'Holidays end', at: now + 5000, action: { kind: 'restore', after: '#0' }, programs: {} },
      ],
    });
    await scheduler.runDue(now + 2000);
    expect(state.lineup).toEqual([C]);
    await scheduler.runDue(now + 6000);
    expect(state.lineup).toEqual([A, B]);

    // Someone edits during the next overlay: its end is skipped, not forced.
    await scheduler.store.add({
      group: 'overlay',
      changes: [
        { channelId: CHANNEL, channelName: '', label: 'Again', at: now + 7000, action: { kind: 'lineup', lineup: [C], expectVersion: programmingVersion([A, B], undefined) }, programs: {} },
        { channelId: CHANNEL, channelName: '', label: 'Again ends', at: now + 9000, action: { kind: 'restore', after: '#0' }, programs: {} },
      ],
    });
    await scheduler.runDue(now + 8000);
    state.lineup = [C, A];
    await scheduler.runDue(now + 10_000);
    expect(state.lineup).toEqual([C, A]);
    const ended = (await scheduler.store.list()).find((change) => change.label === 'Again ends') as ScheduledChange;
    expect(ended.status).toBe('skipped');
    expect(ended.message).toContain('Snapshots');
  });

  it('skips changes the companion missed, and cancels a whole plan together', async () => {
    const { scheduler } = await fakeTunarr([A]);
    await scheduler.store.add({ group: 'save', changes: [{ channelId: CHANNEL, channelName: '', label: 'Late', at: now, notAfter: now + 1000, action: { kind: 'lineup', lineup: [B], expectVersion: 'x-y-z' }, programs: {} }] });
    await scheduler.runDue(now + 5000);
    expect((await scheduler.store.list())[0]).toMatchObject({ status: 'skipped', message: expect.stringContaining('Missed') });

    const plan = await scheduler.store.add({
      group: 'overlay',
      changes: [
        { channelId: CHANNEL, channelName: '', label: 'One', at: now + 10_000, action: { kind: 'lineup', lineup: [B], expectVersion: 'x-y-z' }, programs: {} },
        { channelId: CHANNEL, channelName: '', label: 'Two', at: now + 20_000, action: { kind: 'restore', after: '#0' }, programs: {} },
      ],
    });
    expect(await scheduler.store.cancel(plan[0].id)).toBe(true);
    expect((await scheduler.store.list()).filter((change) => change.planId === plan[0].planId).map((change) => change.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('refuses new plans when the scheduler is off, but still lists', async () => {
    const { config } = await fakeTunarr([A], { schedulerOn: false });
    const list = await handleTunarrApi({ method: 'GET', url: '/api/tunarr/scheduled', headers: { host: 'lineup.local' } }, config);
    expect(JSON.parse(String(list.body))).toMatchObject({ enabled: false, changes: [] });
    const refused = await handleTunarrApi(post('/api/tunarr/scheduled', { group: 'save', changes: [] }), config);
    expect(refused.status).toBe(503);
  });
});
