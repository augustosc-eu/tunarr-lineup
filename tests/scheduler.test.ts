import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { itemIdentity, programmingVersion } from '../server/lineupVersion';
import { premierePlacement } from '../server/premiere';
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
async function fakeTunarr(initial: unknown[], options: { schedulerOn?: boolean; startTime?: number; schedule?: unknown } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'lineup-scheduler-'));
  const state = { lineup: initial as unknown[], saves: [] as unknown[][], startTime: options.startTime ?? 0, schedule: options.schedule };
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith(`/api/channels/${CHANNEL}`) && init?.method === 'PUT') {
      state.startTime = (JSON.parse(String(init.body)) as { startTime: number }).startTime;
      return new Response('{}', { status: 200 });
    }
    if (url.endsWith(`/api/channels/${CHANNEL}`)) return new Response(JSON.stringify({ id: CHANNEL, startTime: state.startTime, programCount: 3 }), { status: 200 });
    if (url.endsWith(`/api/channels/${CHANNEL}/programming`) && init?.method === 'POST') {
      state.lineup = (JSON.parse(String(init.body)) as { lineup: unknown[] }).lineup;
      state.saves.push(state.lineup);
      return new Response(JSON.stringify({ lineup: state.lineup }), { status: 200 });
    }
    if (url.endsWith(`/api/channels/${CHANNEL}/programming`)) return new Response(JSON.stringify({ lineup: state.lineup, programs: {}, ...(state.schedule ? { schedule: state.schedule } : {}) }), { status: 200 });
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

  it('accepts a premiere on its own, going in up to two days before it starts', () => {
    const premiere = { channelId: CHANNEL, label: 'Pilot', at: now + 60_000, action: { kind: 'premiere', startsAt: now + 3_600_000, insert: [EVENT] } };
    const plan = validatePlan({ group: 'premiere', changes: [premiere] }, now, []);
    expect(plan).toMatchObject({ group: 'premiere', changes: [{ notAfter: now + 3_600_000 }] });
    expect(validatePlan({ group: 'premiere', changes: [{ ...premiere, action: { ...premiere.action, startsAt: now } }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'premiere', changes: [{ ...premiere, action: { ...premiere.action, startsAt: now + 3 * 86_400_000 } }] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'save', changes: [premiere] }, now, [])).toHaveProperty('error');
    expect(validatePlan({ group: 'premiere', changes: [{ ...premiere, action: { ...premiere.action, insert: [] } }] }, now, [])).toHaveProperty('error');
  });

  it('places a premiere at the boundary before it, with flex up to it, keeping what is on air', () => {
    const HALF = 1_800_000;
    const lineup = [A, B, C];
    // The lineup has played ten times; A is on now.
    const start = now - 10 * 3 * HALF - 600_000;
    const at = now - 600_000 + HALF + 1_000_000;
    const placed = premierePlacement(lineup, start, now, at, EVENT.duration)!;
    expect(placed).toMatchObject({ index: 1, gap: 1_000_000, start: at });
    // The pass on air starts where it did, so A and the boundary keep their times.
    expect(placed.startTime + 10 * (3 * HALF + 1_000_000 + EVENT.duration)).toBe(start + 10 * 3 * HALF);
    // A start inside the program on now waits for it to end.
    expect(premierePlacement(lineup, start, now, now + 60_000, EVENT.duration)).toMatchObject({ index: 1, gap: 0, start: now - 600_000 + HALF });
    // Past the end of this pass: at the end of it.
    expect(premierePlacement(lineup, start, now, now - 600_000 + 3 * HALF + 300_000, EVENT.duration)).toMatchObject({ index: 3, gap: 300_000 });
    expect(premierePlacement(lineup, start, now, now - 1000, EVENT.duration)).toBeNull();
    expect(premierePlacement([], start, now, at, EVENT.duration)).toBeNull();
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

  it('puts a premiere in just before it starts and moves the start so what is on air stays', async () => {
    const start = Date.now() - 2 * 5_400_000 - 600_000;
    const { state, scheduler } = await fakeTunarr([A, B, C], { startTime: start });
    const startsAt = Date.now() + 1_800_000;
    await scheduler.store.add({ group: 'premiere', changes: [{ channelId: CHANNEL, channelName: '', label: 'Pilot', at: Date.now() - 1000, notAfter: startsAt, action: { kind: 'premiere', startsAt, insert: [EVENT] }, programs: {} }] });
    await scheduler.runDue(Date.now());
    expect(state.lineup.map((item) => (item as { type: string }).type)).toEqual(['content', 'flex', 'content', 'content', 'content']);
    expect(state.lineup[2]).toEqual(EVENT);
    const [change] = await scheduler.store.list();
    expect(change).toMatchObject({ status: 'done', group: 'premiere' });
    // A is on now and the premiere starts inside B: it goes in after A. On the new
    // lineup and start time, it airs right on time.
    const length = state.lineup.reduce((sum: number, item) => sum + (item as { duration: number }).duration, 0);
    const pass = Math.floor((startsAt - state.startTime) / length);
    expect(state.startTime + pass * length + A.duration + (state.lineup[1] as { duration: number }).duration).toBe(startsAt);
  });

  it('skips a premiere on a channel that is now generated from a slot schedule', async () => {
    const { state, scheduler } = await fakeTunarr([A, B, C], { startTime: Date.now() - 600_000, schedule: { type: 'time', slots: [] } });
    await scheduler.store.add({ group: 'premiere', changes: [{ channelId: CHANNEL, channelName: '', label: 'Pilot', at: Date.now() - 1000, notAfter: Date.now() + 3_600_000, action: { kind: 'premiere', startsAt: Date.now() + 3_600_000, insert: [EVENT] }, programs: {} }] });
    await scheduler.runDue(Date.now());
    expect(state.saves).toHaveLength(0);
    expect((await scheduler.store.list())[0]).toMatchObject({ status: 'skipped' });
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
