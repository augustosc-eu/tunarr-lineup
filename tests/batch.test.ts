import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalProgram, exportPackage, missingPositions, nextAirings, planRenumber, renumberProblems, repairLineup, settingsVersion, spareNumber, validateApply, validateBatch, type BatchPreview } from '../server/batch';
import { applyBody } from '../lib/batch';
import { createBatchStore, type BatchRecord } from '../server/batchStore';
import { programmingVersion } from '../server/lineupVersion';
import { buildPackage, validatePackage } from '../server/programmingPackage';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

const ID = (n: number) => `c${n}`;
const P = (n: number) => `0b6f5c4e-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;
const LIST_A = '5e5e5e5e-1a2b-4c3d-8e9f-00000000000a';
const LIST_B = '5e5e5e5e-1a2b-4c3d-8e9f-00000000000b';
const PROFILE = '6f6f6f6f-1a2b-4c3d-8e9f-000000000001';
const MIN = 60_000;

type Channel = Record<string, unknown> & { id: string; number: number; name: string };

/** A small stateful Tunarr: channels, programming, lists, profiles. Refuses duplicate channel numbers like a careful server. */
function fakeTunarr() {
  const state = {
    channels: [1, 2, 3, 4].map((n) => ({ id: ID(n), number: n, name: `Channel ${n}`, groupTitle: 'tunarr', startTime: 0, transcodeConfigId: PROFILE, fillerCollections: [], fillerRepeatCooldown: 30_000, disableFillerOverlay: false, stealth: false, programCount: 3, sessions: [] })) as Channel[],
    programming: Object.fromEntries([1, 2, 3, 4].map((n) => [ID(n), {
      lineup: [{ type: 'content', id: P(1), duration: 30 * MIN, persisted: true, startOffsetMs: 0 }, { type: 'content', id: P(99), duration: 20 * MIN, customField: 'kept' }, { type: 'flex', duration: 5 * MIN, fillerConfig: { fillerListIds: [LIST_A] } }, { type: 'redirect', channel: ID(1), duration: 5 * MIN }],
      programs: { [P(1)]: { title: 'Kept Program' } },
      ...(n === 4 ? { schedule: { type: 'random', slots: [] } } : {}),
    }])) as Record<string, { lineup: unknown[]; programs: Record<string, unknown>; schedule?: unknown }>,
    // Programs Tunarr indexes, as GET /api/programs/:id describes them.
    library: { [P(5)]: { type: 'content', subtype: 'movie', id: P(5), duration: 25 * MIN, title: 'Replacement Movie' }, [P(6)]: { type: 'show', id: P(6), title: 'A Show' } } as Record<string, Record<string, unknown>>,
    /** Reads of the channel list so far, and an outside change made on one of them (someone editing Tunarr mid-batch). */
    listReads: 0,
    onList: undefined as undefined | ((read: number) => void),
    down: false,
    downAfterPuts: Infinity,
    puts: 0,
    writes: [] as Array<{ method: string; path: string; body: unknown }>,
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    if (state.down) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') state.writes.push({ method, path: url.pathname, body });
    if (url.pathname === '/api/channels') {
      state.listReads += 1;
      state.onList?.(state.listReads);
      return json(state.channels);
    }
    if (url.pathname === '/api/filler-lists') return json([{ id: LIST_A, name: 'Ads A' }, { id: LIST_B, name: 'Ads B' }]);
    if (url.pathname === '/api/transcode_configs') return json([{ id: PROFILE, name: 'Default' }]);
    const program = /^\/api\/programs\/([^/]+)$/.exec(url.pathname);
    if (program && method === 'GET') return state.library[program[1]] ? json(state.library[program[1]]) : json({ message: 'Program not found' }, 404);
    const doc = /^\/api\/channels\/([^/]+)$/.exec(url.pathname);
    if (doc) {
      const channel = state.channels.find((item) => item.id === doc[1]);
      if (!channel) return json({ error: 'Channel Not Found' }, 404);
      if (method === 'PUT') {
        state.puts += 1;
        if (state.puts > state.downAfterPuts) { state.down = true; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }
        if ('programCount' in body || 'sessions' in body) return json('Unexpected read-only fields', 400);
        if (state.channels.some((item) => item.id !== channel.id && item.number === body.number)) return json('Channel number already in use', 400);
        Object.assign(channel, body);
      }
      return json(channel);
    }
    const programming = /^\/api\/channels\/([^/]+)\/programming$/.exec(url.pathname);
    if (programming) {
      const current = state.programming[programming[1]];
      if (method === 'POST') current.lineup = body.lineup;
      return json(current);
    }
    return json({ error: 'nope' }, 404);
  });
  return { state, fetchImpl };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lineup-batch-'));
  const fake = fakeTunarr();
  const config: ProxyConfig = { ...createProxyConfig({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://tunarr:8000' }), fetchImpl: fake.fetchImpl as unknown as typeof fetch };
  return { ...fake, config, dir };
}

const target = { origin: 'http://tunarr:8000', basePath: '', host: 'tunarr:8000' };
const post = (url: string, body: unknown): ProxyRequest => ({ method: 'POST', url, headers: { host: 'lineup.local', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (url: string): ProxyRequest => ({ method: 'GET', url, headers: { host: 'lineup.local' } });
const read = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

async function preview(config: ProxyConfig, body: Record<string, unknown>): Promise<BatchPreview> {
  const response = await handleTunarrApi(post('/api/tunarr/batch/preview', body), config);
  expect(response.status).toBe(200);
  return read(response);
}

/** Applies what was previewed and waits for the background job to finish. */
async function apply(config: ProxyConfig, body: Record<string, unknown>, previewed: BatchPreview): Promise<BatchRecord> {
  const expect_ = Object.fromEntries(previewed.channels.filter((channel) => channel.expect).map((channel) => [channel.channelId, channel.expect]));
  const response = await handleTunarrApi(post('/api/tunarr/batch/apply', { ...body, expect: expect_, label: previewed.label }), config);
  expect(response.status).toBe(202);
  return waitFor(config, read(response).id);
}

async function waitFor(config: ProxyConfig, id: string, done = (record: BatchRecord & { running?: boolean }) => !!record.finishedAt && !record.running): Promise<BatchRecord> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = read(await handleTunarrApi(get(`/api/tunarr/batches/${id}`), config)) as BatchRecord & { running?: boolean };
    if (done(record)) return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('batch did not finish');
}
const outcomes = (record: BatchRecord) => Object.fromEntries(record.channels.map((channel) => [channel.channelId, channel.status]));

describe('validating a batch', () => {
  it('accepts only known operations, allowlisted fields and valid channel ids', () => {
    expect('error' in validateBatch({ operation: 'delete', channelIds: [ID(1)] })).toBe(true);
    expect('error' in validateBatch({ operation: 'group', channelIds: [], params: { changes: { groupTitle: 'x' } } })).toBe(true);
    expect('error' in validateBatch({ operation: 'group', channelIds: ['../x'], params: { changes: { groupTitle: 'x' } } })).toBe(true);
    expect(validateBatch({ operation: 'group', channelIds: [ID(1)], params: { changes: { groupTitle: 'x', name: 'renamed' } } })).toMatchObject({ error: expect.stringContaining('only: Group') });
    expect(validateBatch({ operation: 'settings', channelIds: [ID(1)], params: { changes: { icon: { path: 'x' } } } })).toMatchObject({ error: expect.stringContaining('only:') });
    expect(validateBatch({ operation: 'settings', channelIds: [ID(1)], params: { changes: { stealth: 'yes' } } })).toMatchObject({ error: expect.any(String) });
    expect(validateBatch({ operation: 'filler', channelIds: [ID(1)], params: { changes: { fillerRepeatCooldown: 1 } } })).toMatchObject({ error: 'Choose the filler lists.' });
    expect(validateBatch({ operation: 'group', channelIds: [ID(1), ID(1)], params: { changes: { groupTitle: 'News' } } })).toEqual({ channelIds: [ID(1)], params: { operation: 'group', changes: { groupTitle: 'News' } } });
  });

  it('refuses duplicate or invalid new numbers', () => {
    expect(validateBatch({ operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 7, [ID(2)]: 7 } } })).toEqual({ error: 'Two channels can’t get the same number.' });
    expect('error' in validateBatch({ operation: 'renumber', channelIds: [ID(1)], params: { numbers: { [ID(1)]: 0 } } })).toBe(true);
    expect('error' in validateBatch({ operation: 'renumber', channelIds: [ID(1)], params: { numbers: { [ID(1)]: 5, [ID(2)]: 6 } } })).toBe(true);
    expect(renumberProblems([{ id: ID(1), number: 1, name: 'One' }, { id: ID(2), number: 2, name: 'Two' }], { [ID(1)]: 2 }).get(ID(1))).toContain('CH 2 is already Two');
    expect(renumberProblems([{ id: ID(1), number: 1, name: 'One' }, { id: ID(2), number: 2, name: 'Two' }], { [ID(1)]: 2, [ID(2)]: 1 }).size).toBe(0);
  });

  it('refuses malformed imports and repairs', () => {
    expect(validateBatch({ operation: 'import', params: { package: { format: 'zip' }, mapping: {} } })).toEqual({ error: 'This isn’t a Tunarr Lineup programming package.' });
    expect(validateBatch({ operation: 'import', params: { package: { format: 'tunarr-lineup-package', version: 9, channels: [] }, mapping: {} } })).toMatchObject({ error: expect.stringContaining('version 9') });
    const pkg = buildPackage([{ id: 'src', number: 1, name: 'Src', version: 'v', hadSchedule: false, lineup: [{ type: 'content', id: P(1), duration: 60_000 }], programs: {} }]);
    expect(validateBatch({ operation: 'import', params: { package: { ...pkg, channels: [{ ...pkg.channels[0], lineup: [{ type: 'content', duration: 0 }] }] }, mapping: { src: ID(1) } } })).toMatchObject({ error: expect.stringContaining('positive duration') });
    expect(validateBatch({ operation: 'import', params: { package: pkg, mapping: { other: ID(1) } } })).toMatchObject({ error: expect.stringContaining('isn’t in the package') });
    expect(validateBatch({ operation: 'import', params: { package: pkg, mapping: { src: ID(1) } } })).toMatchObject({ channelIds: [ID(1)] });
    expect('error' in validateBatch({ operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'replace', replacement: { id: 'not-a-uuid', duration: 1 } } } } })).toBe(true);
    expect('error' in validateBatch({ operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'explode' } } } })).toBe(true);
    // The length a page sends is dropped: only the id is kept.
    expect(validateBatch({ operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'replace', replacement: { id: P(5), duration: 1 } } } } })).toMatchObject({ params: { decisions: { [P(99)]: { action: 'replace', replacement: { id: P(5) } } } } });
    expect('error' in validateApply({ operation: 'group', channelIds: [ID(1)], params: { changes: { groupTitle: 'x' } } })).toBe(true);
  });

  it('validates packages: drops everything but titles from programs', () => {
    const checked = validatePackage({ format: 'tunarr-lineup-package', version: 1, channels: [{ id: 'a', number: 1, name: 'A', lineup: [{ type: 'content', id: P(1), duration: 1000 }], programs: { [P(1)]: { title: 'T', artwork: [{ path: 'http://10.0.0.9:32400/x?X-Plex-Token=secret' }] } } }] });
    expect('package' in checked && checked.package.channels[0].programs).toEqual({ [P(1)]: { title: 'T' } });
  });
});

describe('media repair rules', () => {
  const lineup = [{ type: 'content', id: P(1), duration: 10 * MIN }, { type: 'content', id: P(99), duration: 20 * MIN, extra: true }, { type: 'flex', duration: 5 * MIN }, { type: 'content', id: P(99), duration: 20 * MIN }];

  it('finds missing programs and when they air next', () => {
    const missing = missingPositions({ lineup, programs: { [P(1)]: {} } });
    expect([...missing]).toEqual([[P(99), [1, 3]]]);
    // Cycle 55 min from 0: #1 airs at 10 min, then every 55 min.
    expect(nextAirings(lineup, 0, 1, 12 * MIN)).toEqual([10 * MIN, 65 * MIN, 120 * MIN]);
    expect(nextAirings(lineup, 0, 1, 31 * MIN)).toEqual([65 * MIN, 120 * MIN, 175 * MIN]);
    expect(nextAirings(lineup, NaN, 1, 0)).toEqual([]);
  });

  it('removes, keeps time with flex, or replaces, leaving every other item the same object', () => {
    const missing = new Map([[P(99), [1, 3]]]);
    const flexed = repairLineup(lineup, missing, { [P(99)]: { action: 'flex' } });
    expect(flexed.lineup).toEqual([lineup[0], { type: 'flex', duration: 20 * MIN }, lineup[2], { type: 'flex', duration: 20 * MIN }]);
    expect(flexed.lineup[0]).toBe(lineup[0]);
    expect(flexed.lineup[2]).toBe(lineup[2]);
    expect(repairLineup(lineup, missing, { [P(99)]: { action: 'remove' } })).toMatchObject({ lineup: [lineup[0], lineup[2]], removed: 2, positions: [1, 3] });
    expect(repairLineup(lineup, missing, { [P(99)]: { action: 'replace', replacement: { id: P(5), duration: 15 * MIN } } }).lineup[1]).toEqual({ type: 'content', id: P(5), duration: 15 * MIN });
    // A replacement that wasn't looked up in Tunarr (no length) is never planned.
    expect(() => repairLineup(lineup, missing, { [P(99)]: { action: 'replace', replacement: { id: P(5) } } })).toThrow();
    expect(repairLineup(lineup, missing, { [P(99)]: { action: 'ignore' } }).lineup).toEqual(lineup);
  });

  it('takes a replacement’s identity and length only from Tunarr’s copy of the program', () => {
    expect(canonicalProgram({ type: 'content', subtype: 'episode', id: P(5), duration: 1_500_000.4, title: 'Ep' }, P(5))).toEqual({ id: P(5), duration: 1_500_000, title: 'Ep' });
    expect(canonicalProgram({ uuid: P(5), duration: 60_000 }, P(5))).toMatchObject({ id: P(5) });
    expect(canonicalProgram({ id: P(7), duration: 60_000 }, P(5))).toBeNull();
    expect(canonicalProgram({ type: 'show', id: P(5), duration: 60_000 }, P(5))).toBeNull();
    expect(canonicalProgram({ id: P(5), duration: 0 }, P(5))).toBeNull();
    expect(canonicalProgram({ id: P(5) }, P(5))).toBeNull();
    expect(canonicalProgram(null, P(5))).toBeNull();
  });
});

describe('settings batches', () => {
  it('previews exactly what changes per channel, and what doesn’t', async () => {
    const { config, state } = await setup();
    state.channels[1].groupTitle = 'News';
    const result = await preview(config, { operation: 'group', channelIds: [ID(1), ID(2), 'gone'], params: { changes: { groupTitle: 'News' } } });
    expect(result.label).toBe('Group → “News” on 1 channel');
    expect(result.channels.map((channel) => [channel.channelId, channel.status])).toEqual([[ID(1), 'ready'], [ID(2), 'unchanged'], ['gone', 'blocked']]);
    expect(result.channels[0].changes).toEqual([{ field: 'groupTitle', label: 'Group', before: '“tunarr”', after: '“News”' }]);
    expect(state.writes).toEqual([]);
  });

  it('copies filler settings, naming the lists in the preview', async () => {
    const { config, state } = await setup();
    const body = { operation: 'filler', channelIds: [ID(1), ID(2)], params: { changes: { fillerCollections: [{ id: LIST_A, weight: 1, cooldownSeconds: 0 }, { id: LIST_B, weight: 2, cooldownSeconds: 0 }], fillerRepeatCooldown: 60_000 } } };
    const result = await preview(config, body);
    expect(result.channels[0].changes).toEqual([
      { field: 'fillerCollections', label: 'Filler lists', before: 'none', after: 'Ads A, Ads B (weight 2)' },
      { field: 'fillerRepeatCooldown', label: 'Filler repeat cooldown', before: '30 s', after: '60 s' },
    ]);
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'done' });
    expect(state.channels[0].fillerCollections).toHaveLength(2);
    // Merged onto Tunarr's copy: everything else kept, read-only fields not sent.
    const put = state.writes.find((write) => write.method === 'PUT') as { body: Record<string, unknown> };
    expect(put.body).toMatchObject({ name: 'Channel 1', transcodeConfigId: PROFILE, startTime: 0 });
    expect(put.body).not.toHaveProperty('programCount');
    expect(record.channels[0].before).toEqual({ fillerCollections: [], fillerRepeatCooldown: 30_000 });
  });

  it('applies the safe channels and reports a conflict on one changed since the preview, never forcing it', async () => {
    const { config, state } = await setup();
    const body = { operation: 'transcode', channelIds: [ID(1), ID(2), ID(3)], params: { changes: { transcodeConfigId: PROFILE.replace('01', '02') } } };
    // An unknown profile is refused in the preview.
    expect((await handleTunarrApi(post('/api/tunarr/batch/preview', body), config)).status).toBe(400);
    const groups = { operation: 'group', channelIds: [ID(1), ID(2), ID(3)], params: { changes: { groupTitle: 'Movies' } } };
    const result = await preview(config, groups);
    state.channels[1].groupTitle = 'Changed elsewhere';
    const record = await apply(config, groups, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'conflict', [ID(3)]: 'done' });
    expect(state.channels[1].groupTitle).toBe('Changed elsewhere');
    expect(record.channels[1].message).toContain('Changed in Tunarr since the preview');
  });

  it('stops trying when Tunarr goes down mid-batch, and says which channels weren’t tried', async () => {
    const { config, state } = await setup();
    const body = { operation: 'settings', channelIds: [ID(1), ID(2), ID(3)], params: { changes: { stealth: true } } };
    const result = await preview(config, body);
    state.downAfterPuts = 1;
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'failed', [ID(3)]: 'skipped' });
    expect(record.channels[2].message).toMatch(/^Not tried: Tunarr stopped answering/);
    expect(record.finishedAt).toBeTruthy();
  });

  it('rolls back chosen channels only while they still match the batch', async () => {
    const { config, state } = await setup();
    const body = { operation: 'group', channelIds: [ID(1), ID(2), ID(3)], params: { changes: { groupTitle: 'Kids' } } };
    const record = await apply(config, body, await preview(config, body));
    state.channels[2].groupTitle = 'Edited after';
    const response = await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1), ID(3)] }), config);
    expect(response.status).toBe(202);
    const rolled = await waitFor(config, record.id, (item) => !item.running && item.channels.every((channel) => channel.rollback?.message !== 'Rolling back…'));
    expect(rolled.channels.map((channel) => channel.rollback?.status)).toEqual(['done', undefined, 'conflict']);
    expect(state.channels.map((channel) => channel.groupTitle)).toEqual(['tunarr', 'Kids', 'Edited after', 'tunarr']);
    // Nothing left to roll back on a channel already rolled back.
    expect((await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1)] }), config)).status).toBe(400);
    // A rollback asked for a channel it can't roll back, or an id that isn't one, rolls back nothing.
    expect((await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1), ID(3)] }), config)).status).toBe(400);
    expect((await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(3), '../x'] }), config)).status).toBe(400);
  });
});

describe('applying exactly what was previewed', () => {
  const group = { operation: 'group', channelIds: [ID(1), ID(2)], params: { changes: { groupTitle: 'News' } } };

  it('refuses an apply missing a channel’s fingerprint, or with one that isn’t valid, instead of dropping the channel', () => {
    expect(validateApply({ ...group, expect: { [ID(1)]: 'abc-1' } })).toEqual({ error: '1 of the 2 channels wasn’t previewed (or the preview didn’t come through whole), so nothing was changed. Preview again.' });
    expect(validateApply({ ...group, expect: { [ID(1)]: 'abc-1', [ID(2)]: '' } })).toHaveProperty('error');
    expect(validateApply({ ...group, expect: { [ID(1)]: 'abc-1', [ID(2)]: 'not a fingerprint!' } })).toHaveProperty('error');
    expect(validateApply({ ...group, expect: { [ID(1)]: 'abc-1', [ID(2)]: 7 } })).toHaveProperty('error');
    expect(validateApply({ ...group, expect: {} })).toMatchObject({ error: expect.stringContaining('None of these channels was previewed') });
    expect(validateApply({ ...group, expect: { [ID(1)]: 'abc-1', [ID(2)]: 'abc-2', [ID(3)]: 'abc-3' } })).toMatchObject({ error: expect.stringContaining('aren’t in this batch') });
    const ok = validateApply({ ...group, expect: { [ID(1)]: 'abc-1', [ID(2)]: 'abc-2' } });
    expect('expect' in ok && [ok.channelIds, [...ok.expect]]).toEqual([[ID(1), ID(2)], [[ID(1), 'abc-1'], [ID(2), 'abc-2']]]);
  });

  it('checks every operation the same way, and their per-channel parts against the channels', () => {
    const two = { [ID(1)]: 'abc-1', [ID(2)]: 'abc-2' };
    for (const body of [
      { operation: 'settings', channelIds: [ID(1), ID(2)], params: { changes: { stealth: true } } },
      { operation: 'filler', channelIds: [ID(1), ID(2)], params: { changes: { fillerCollections: [] } } },
      { operation: 'transcode', channelIds: [ID(1), ID(2)], params: { changes: { transcodeConfigId: PROFILE } } },
      { operation: 'repair', channelIds: [ID(1), ID(2)], params: { decisions: { [P(99)]: { action: 'remove' } } } },
      { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } },
    ]) {
      expect([body.operation, 'error' in validateApply({ ...body, expect: { [ID(1)]: 'abc-1' } })]).toEqual([body.operation, true]);
      expect([body.operation, 'error' in validateApply({ ...body, expect: two })]).toEqual([body.operation, false]);
    }
    // A renumbering's numbers must be exactly its channels'.
    expect(validateApply({ operation: 'renumber', channelIds: [ID(1)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } }, expect: { [ID(1)]: 'abc-1' } })).toHaveProperty('error');
    const pkg = buildPackage([{ id: 'src', number: 1, name: 'Src', version: 'v', hadSchedule: false, lineup: [{ type: 'content', id: P(1), duration: MIN }], programs: {} }]);
    const imported = { operation: 'import', params: { package: pkg, mapping: { src: ID(2) } } };
    expect('error' in validateApply({ ...imported, expect: { [ID(2)]: 'abc-2' } })).toBe(false);
    expect('error' in validateApply({ ...imported, channelIds: [ID(2)], expect: { [ID(2)]: 'abc-2' } })).toBe(false);
    expect(validateApply({ ...imported, channelIds: [ID(1), ID(2)], expect: { [ID(2)]: 'abc-2' } })).toMatchObject({ error: expect.stringContaining('don’t match') });
    expect(validateApply({ ...imported, expect: {} })).toHaveProperty('error');
  });

  it('writes nothing and records no batch for an apply that names a channel it didn’t preview', async () => {
    const { config, state } = await setup();
    const result = await preview(config, group);
    const response = await handleTunarrApi(post('/api/tunarr/batch/apply', { ...group, expect: { [ID(1)]: result.channels[0].expect }, label: result.label }), config);
    expect(response.status).toBe(400);
    expect(read(response).error).toMatchObject({ code: 'invalid_request', message: expect.stringContaining('wasn’t previewed') });
    expect(state.writes).toEqual([]);
    expect(read(await handleTunarrApi(get('/api/tunarr/batches'), config))).toEqual([]);
    // With both, it goes in as before.
    const record = await apply(config, group, result);
    expect(record.channels.map((channel) => channel.status)).toEqual(['done', 'done']);
  });

  it('moves no channel for a renumbering missing one fingerprint', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    const response = await handleTunarrApi(post('/api/tunarr/batch/apply', { ...body, expect: { [ID(2)]: result.channels[1].expect }, label: result.label }), config);
    expect(response.status).toBe(400);
    expect(state.writes).toEqual([]);
    expect(state.channels.map((channel) => channel.number)).toEqual([1, 2, 3, 4]);
  });

  it('the desk sends only the channels a preview would change, with their parts cut to match', () => {
    const previewed = { operation: 'renumber', label: 'Renumber', channels: [{ channelId: ID(1), status: 'ready', expect: 'v1' }, { channelId: ID(2), status: 'unchanged', expect: 'v2' }, { channelId: ID(3), status: 'ready', expect: 'v3' }] } as unknown as BatchPreview;
    const body = applyBody({ operation: 'renumber', channelIds: [ID(1), ID(2), ID(3)], params: { numbers: { [ID(1)]: 5, [ID(2)]: 2, [ID(3)]: 6 } } }, previewed);
    expect(body).toEqual({ operation: 'renumber', channelIds: [ID(1), ID(3)], params: { numbers: { [ID(1)]: 5, [ID(3)]: 6 } }, expect: { [ID(1)]: 'v1', [ID(3)]: 'v3' }, label: 'Renumber' });
    expect('error' in validateApply(body)).toBe(false);
    const imported = applyBody({ operation: 'import', params: { package: {}, mapping: { a: ID(1), b: ID(2) } } }, { ...previewed, operation: 'import' } as BatchPreview);
    expect(imported.params).toEqual({ package: {}, mapping: { a: ID(1) } });
  });
});

describe('renumbering', () => {
  it('swaps numbers without two channels ever sharing one, and swaps them back', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2), ID(3)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 1 } } };
    const result = await preview(config, body);
    expect(result.channels.map((channel) => channel.status)).toEqual(['ready', 'ready', 'ready']);
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'done', [ID(3)]: 'done' });
    expect(state.channels.map((channel) => channel.number)).toEqual([2, 3, 1, 4]);
    // The fake refuses duplicates, so a clean result means no step ever collided.
    expect(state.writes.filter((write) => write.method === 'PUT').length).toBe(4);
    await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1), ID(2), ID(3)] }), config);
    await waitFor(config, record.id, (item) => !item.running && item.channels.every((channel) => channel.rollback?.status === 'done'));
    expect(state.channels.map((channel) => channel.number)).toEqual([1, 2, 3, 4]);
  });

  const numbersOf = (state: { channels: Channel[] }) => state.channels.map((channel) => channel.number);
  const puts = (state: { writes: Array<{ method: string }> }) => state.writes.filter((write) => write.method === 'PUT').length;

  it('parks on a spare number inside 1–99,999 that nothing has or is moving to', () => {
    expect(spareNumber([1, 2, 3])).toBe(4);
    expect(spareNumber([1, 99_999, 3, 4])).toBe(99_998);
    expect(spareNumber([99_997, 99_998, 99_999, 1])).toBe(99_996);
    expect(spareNumber([1, 2, 3], 3)).toBeNull();
    expect(spareNumber([2, 3], 3)).toBe(1);
    expect(spareNumber([])).toBe(1);
    // A three-channel cycle at the top of the range: every step stays in range, and the spare is free.
    const numberOf = new Map([['a', 99_997], ['b', 99_998], ['c', 99_999], ['d', 99_996]]);
    const plan = planRenumber(numberOf, new Map([['a', 99_998], ['b', 99_999], ['c', 99_997]]));
    expect('steps' in plan && plan.steps).toEqual([
      { channelId: 'a', number: 99_995, park: true },
      { channelId: 'c', number: 99_997, park: false },
      { channelId: 'b', number: 99_999, park: false },
      { channelId: 'a', number: 99_998, park: false },
    ]);
    // A swap with nowhere to pass through is refused as a whole.
    expect(planRenumber(new Map([['a', 1], ['b', 2]]), new Map([['a', 2], ['b', 1]]), 2)).toMatchObject({ error: expect.stringContaining('needs one free number') });
    expect(planRenumber(new Map([['a', 1], ['b', 2]]), new Map([['a', 3]]), 3)).toEqual({ steps: [{ channelId: 'a', number: 3, park: false }] });
  });

  it('swaps CH 99,999 through a free number below it, never above the range', async () => {
    const { config, state } = await setup();
    state.channels[1].number = 99_999;
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 99_999, [ID(2)]: 1 } } };
    const record = await apply(config, body, await preview(config, body));
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'done' });
    expect(numbersOf(state)).toEqual([99_999, 1, 3, 4]);
    const used = state.writes.filter((write) => write.method === 'PUT').map((write) => (write.body as { number: number }).number);
    expect(used).toEqual([99_998, 1, 99_999]);
    expect(used.every((number) => number >= 1 && number <= 99_999)).toBe(true);
  });

  it('rotates three channels at the top of the range', async () => {
    const { config, state } = await setup();
    [99_997, 99_998, 99_999].forEach((number, index) => { state.channels[index].number = number; });
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2), ID(3)], params: { numbers: { [ID(1)]: 99_998, [ID(2)]: 99_999, [ID(3)]: 99_997 } } };
    const record = await apply(config, body, await preview(config, body));
    expect(Object.values(outcomes(record))).toEqual(['done', 'done', 'done']);
    expect(numbersOf(state)).toEqual([99_998, 99_999, 99_997, 4]);
    expect(state.writes.every((write) => write.method !== 'PUT' || ((write.body as { number: number }).number >= 1 && (write.body as { number: number }).number <= 99_999))).toBe(true);
  });

  it('refuses a swap before the first write when no number is free to pass through', async () => {
    const { config, state } = await setup();
    // Every number from 5 to 99,999 is taken by a channel outside the batch.
    for (let number = 5; number <= 99_999; number += 1) state.channels.push({ id: `x${number}`, number, name: '' });
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2), ID(3), ID(4)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1, [ID(3)]: 4, [ID(4)]: 3 } } };
    const record = await apply(config, body, await preview(config, body));
    expect(puts(state)).toBe(0);
    expect(state.writes).toEqual([]);
    expect(Object.values(outcomes(record))).toEqual(['blocked', 'blocked', 'blocked', 'blocked']);
    expect(record.channels[0].message).toContain('needs one free number from 1 to 99,999');
  }, 20_000);

  it('stops safely when the spare number is taken in Tunarr just before it’s used', async () => {
    const { config, state } = await setup();
    state.channels[1].number = 99_999;
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 99_999, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    state.listReads = 0;
    // Read 3 is the first step's fresh read, right before parking on 99,998.
    state.onList = (read) => { if (read === 3) state.channels[3].number = 99_998; };
    const record = await apply(config, body, result);
    expect(puts(state)).toBe(0);
    expect(numbersOf(state)).toEqual([1, 99_999, 3, 99_998]);
    expect(Object.values(outcomes(record))).toEqual(['skipped', 'skipped']);
    expect(record.channels.every((channel) => channel.message.includes('CH 99998 was taken in Tunarr'))).toBe(true);
  });

  it('swaps two numbers through a spare one', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } };
    const record = await apply(config, body, await preview(config, body));
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'done' });
    expect(numbersOf(state)).toEqual([2, 1, 3, 4]);
    expect(puts(state)).toBe(3);
  });

  it('moves nothing when Tunarr changes after the batch read it but before the first write', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2), ID(3)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 1 } } };
    const result = await preview(config, body);
    // Reads 1 and 2 are the batch's own (start, plan); read 3 is the first step's fresh read.
    state.listReads = 0;
    state.onList = (read) => { if (read === 3) state.channels[2].number = 9; };
    const record = await apply(config, body, result);
    expect(puts(state)).toBe(0);
    expect(numbersOf(state)).toEqual([1, 2, 9, 4]);
    expect(Object.values(outcomes(record))).not.toContain('done');
    expect(record.channels.find((channel) => channel.status === 'conflict')?.message).toContain('changed in Tunarr while renumbering');
  });

  it('a channel changed since the preview stops the whole renumbering before anything moves', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    state.channels[1].number = 8;
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'skipped', [ID(2)]: 'conflict' });
    expect(puts(state)).toBe(0);
    expect(numbersOf(state)).toEqual([1, 8, 3, 4]);
  });

  it('a channel deleted since the preview stops a swap before anything moves', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    // CH 2 goes away: CH 1 must not take its number.
    state.channels.splice(1, 1);
    const record = await apply(config, body, result);
    expect(puts(state)).toBe(0);
    expect(numbersOf(state)).toEqual([1, 3, 4]);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'skipped', [ID(2)]: 'conflict' });
    expect(record.channels[1].message).toContain('Deleted in Tunarr since the preview');
    expect(record.channels[0].message).toContain('deleted in Tunarr since the preview');
  });

  it('a channel deleted since the preview stops a cycle before anything moves', async () => {
    const { config, state } = await setup();
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2), ID(3)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 1 } } };
    const result = await preview(config, body);
    state.channels.splice(2, 1);
    const record = await apply(config, body, result);
    expect(puts(state)).toBe(0);
    expect(numbersOf(state)).toEqual([1, 2, 4]);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'skipped', [ID(2)]: 'skipped', [ID(3)]: 'conflict' });
  });

  it('stops between steps when Tunarr changes, never overwriting the change, and reports the half-done state', async () => {
    const { config, state } = await setup();
    // A swap: channel 1 is parked on a spare number first, then channel 2 is changed outside Lineup.
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 2, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    state.listReads = 0;
    state.onList = (read) => { if (read === 4) state.channels[1].number = 7; };
    const record = await apply(config, body, result);
    expect(numbersOf(state)).toEqual([5, 7, 3, 4]);
    expect(puts(state)).toBe(1);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'failed', [ID(2)]: 'conflict' });
    expect(record.channels[0].message).toContain('left on the spare CH 5');
    expect(record.channels[1].message).toContain('changed in Tunarr while renumbering');
    const listed = read(await handleTunarrApi(get('/api/tunarr/batches'), config));
    expect(listed[0].counts).toEqual({ failed: 1, conflict: 1 });

    // Rolling back is conditional too: the parked channel goes home; the changed one is left alone.
    await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1)] }), config);
    await waitFor(config, record.id, (item) => !item.running && item.channels[0].rollback?.message !== 'Rolling back…');
    expect(numbersOf(state)).toEqual([1, 7, 3, 4]);
  });

  it('stops after a finished step when a later one finds a change, keeping the finished one as done', async () => {
    const { config, state } = await setup();
    // A chain: channel 1 moves to the free 6 first, then channel 2 takes 1.
    const body = { operation: 'renumber', channelIds: [ID(1), ID(2)], params: { numbers: { [ID(1)]: 6, [ID(2)]: 1 } } };
    const result = await preview(config, body);
    state.listReads = 0;
    state.onList = (read) => { if (read === 4) state.channels[2].number = 1; };
    const record = await apply(config, body, result);
    expect(numbersOf(state)).toEqual([6, 2, 1, 4]);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'skipped' });
    expect(record.channels[1].message).toContain('CH 1 was taken in Tunarr');
  });

  it('blocks a number held by a channel outside the batch', async () => {
    const { config, state } = await setup();
    const result = await preview(config, { operation: 'renumber', channelIds: [ID(1)], params: { numbers: { [ID(1)]: 4 } } });
    expect(result.channels[0]).toMatchObject({ status: 'blocked', reason: expect.stringContaining('CH 4 is already Channel 4') });
    expect(state.writes).toEqual([]);
  });
});

describe('programming batches', () => {
  it('repairs missing media across channels, keeping every other item untouched, after a snapshot', async () => {
    const { config, state } = await setup();
    // The page sends a length, but the companion uses Tunarr's (25 min), never the page's.
    const body = { operation: 'repair', channelIds: [ID(1), ID(2), ID(4)], params: { decisions: { [P(99)]: { action: 'replace', replacement: { id: P(5), duration: 20 * MIN } } } } };
    const result = await preview(config, body);
    expect(result.replacements).toEqual([{ id: P(5), duration: 25 * MIN, title: 'Replacement Movie' }]);
    expect(result.missing).toEqual([{ programId: P(99), duration: 20 * MIN, occurrences: expect.arrayContaining([expect.objectContaining({ channelId: ID(1), positions: [1] })]) }]);
    expect(result.missing![0].occurrences[0].nextAirings.length).toBeGreaterThan(0);
    expect(result.channels.map((channel) => [channel.channelId, channel.status])).toEqual([[ID(1), 'ready'], [ID(2), 'ready'], [ID(4), 'blocked']]);
    expect(result.channels[2].reason).toContain('slot schedule');
    expect(result.channels[0].programming).toMatchObject({ replaced: 1, itemsBefore: 4, itemsAfter: 4 });
    const before = structuredClone(state.programming[ID(1)].lineup);
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'done', [ID(2)]: 'done', [ID(4)]: 'blocked' });
    expect(state.programming[ID(1)].lineup).toEqual([before[0], { type: 'content', id: P(5), duration: 25 * MIN }, before[2], before[3]]);
    expect(state.programming[ID(4)].lineup).toHaveLength(4);
    const snapshots = await config.snapshots!.list(ID(1));
    expect(snapshots[0]).toMatchObject({ id: record.channels[0].snapshotId, reason: expect.stringContaining('Before batch') });

    // Roll back channel 1: the snapshot comes back with a conditional save.
    await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1)] }), config);
    await waitFor(config, record.id, (item) => !item.running && item.channels[0].rollback?.status === 'done');
    expect(state.programming[ID(1)].lineup).toEqual(before);
  });

  it('refuses a replacement Tunarr doesn’t index, or that isn’t a playable program, without touching the channel', async () => {
    const { config, state } = await setup();
    const before = structuredClone(state.programming);
    for (const id of [P(404), P(6)]) {
      const response = await handleTunarrApi(post('/api/tunarr/batch/preview', { operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'replace', replacement: { id, duration: 20 * MIN } } } } }), config);
      expect(response.status).toBe(409);
      expect(read(response).error).toMatchObject({ code: 'replacement_unavailable', message: expect.stringContaining('isn’t in Tunarr’s library') });
    }
    expect(state.writes).toEqual([]);
    expect(state.programming).toEqual(before);
  });

  it('never saves a replacement that disappeared, or changed length, between the preview and the apply', async () => {
    const { config, state } = await setup();
    const body = { operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'replace', replacement: { id: P(5) } } } } };
    const before = structuredClone(state.programming[ID(1)].lineup);
    const gone = await preview(config, body);
    delete state.library[P(5)];
    const record = await apply(config, body, gone);
    expect(record.channels[0]).toMatchObject({ status: 'blocked', message: expect.stringContaining('isn’t in Tunarr’s library') });
    expect(state.programming[ID(1)].lineup).toEqual(before);

    state.library[P(5)] = { type: 'content', id: P(5), duration: 25 * MIN, title: 'Replacement Movie' };
    const changed = await preview(config, body);
    state.library[P(5)].duration = 40 * MIN;
    const second = await apply(config, body, changed);
    expect(second.channels[0]).toMatchObject({ status: 'conflict', message: expect.stringContaining('replacement program changed') });
    expect(state.programming[ID(1)].lineup).toEqual(before);
    expect(state.writes.filter((write) => write.path.endsWith('/programming'))).toEqual([]);
  });

  it('a rollback leaves a lineup changed after the batch alone', async () => {
    const { config, state } = await setup();
    const body = { operation: 'repair', channelIds: [ID(1)], params: { decisions: { [P(99)]: { action: 'remove' } } } };
    const record = await apply(config, body, await preview(config, body));
    state.programming[ID(1)].lineup = [{ type: 'flex', duration: MIN }];
    await handleTunarrApi(post(`/api/tunarr/batches/${record.id}/rollback`, { channelIds: [ID(1)] }), config);
    const rolled = await waitFor(config, record.id, (item) => !item.running && item.channels[0].rollback?.status !== 'skipped');
    expect(rolled.channels[0].rollback).toMatchObject({ status: 'conflict' });
    expect(state.programming[ID(1)].lineup).toEqual([{ type: 'flex', duration: MIN }]);
  });

  it('exports a package without secrets and imports it onto another channel', async () => {
    const { config, state } = await setup();
    state.programming[ID(2)].programs[P(1)] = { title: 'Kept Program', artwork: [{ path: 'http://10.0.0.9:32400/x?X-Plex-Token=secret' }] };
    const exported = read(await handleTunarrApi(post('/api/tunarr/batch/export', { channelIds: [ID(2)] }), config));
    expect(exported).toMatchObject({ format: 'tunarr-lineup-package', version: 1, channels: [{ id: ID(2), number: 2, version: programmingVersion(state.programming[ID(2)].lineup, undefined) }] });
    expect(JSON.stringify(exported)).not.toMatch(/secret|10\.0\.0\.9/);
    const body = { operation: 'import', params: { package: exported, mapping: { [ID(2)]: ID(3) } } };
    state.programming[ID(3)].lineup = [{ type: 'flex', duration: MIN }];
    const result = await preview(config, body);
    expect(result.channels[0]).toMatchObject({ channelId: ID(3), status: 'ready', programming: { itemsBefore: 1, itemsAfter: 4 } });
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(3)]: 'done' });
    expect(state.programming[ID(3)].lineup).toEqual(state.programming[ID(2)].lineup);
    expect(await exportPackage(config, target, [ID(2)])).toMatchObject({ channels: [{ id: ID(2) }] });
  });

  it('refuses an import onto a channel that changed since the preview', async () => {
    const { config, state } = await setup();
    const exported = read(await handleTunarrApi(post('/api/tunarr/batch/export', { channelIds: [ID(2)] }), config));
    const body = { operation: 'import', params: { package: exported, mapping: { [ID(2)]: ID(1) } } };
    const result = await preview(config, body);
    state.programming[ID(1)].lineup = [{ type: 'flex', duration: MIN }];
    const record = await apply(config, body, result);
    expect(outcomes(record)).toEqual({ [ID(1)]: 'conflict' });
    expect(state.programming[ID(1)].lineup).toEqual([{ type: 'flex', duration: MIN }]);
  });
});

describe('the batch record', () => {
  it('lists batches as an audit, without addresses', async () => {
    const { config } = await setup();
    const body = { operation: 'group', channelIds: [ID(1)], params: { changes: { groupTitle: 'News' } } };
    await apply(config, body, await preview(config, body));
    const list = read(await handleTunarrApi(get('/api/tunarr/batches'), config));
    expect(list).toEqual([expect.objectContaining({ operation: 'group', label: 'Group → “News” on 1 channel', counts: { done: 1 }, rolledBack: 0 })]);
    expect(JSON.stringify(list)).not.toContain('tunarr:8000');
    expect((await handleTunarrApi(get('/api/tunarr/batches/not-an-id'), config)).status).toBe(400);
  });

  it('reports a batch the server stopped during as skipped, and never overwrites an unreadable file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lineup-batch-store-'));
    const store = createBatchStore(dir, () => new Set());
    const record = await store.create({ operation: 'group', label: 'x', fields: ['groupTitle'], channels: [{ channelId: ID(1), number: 1, name: 'One', status: 'pending', message: 'Waiting…' }] });
    expect((await store.get(record.id))?.channels[0]).toMatchObject({ status: 'skipped', message: expect.stringContaining('stopped') });
    await writeFile(path.join(dir, 'batches.json'), '{ not json');
    await expect(store.list()).rejects.toMatchObject({ code: 'store_corrupt' });
    const { config } = await setup();
    config.batches = store;
    const response = await handleTunarrApi(get('/api/tunarr/batches'), config);
    expect(response.status).toBe(500);
    expect(read(response).error.code).toBe('store_corrupt');
  });

  it('runs one batch at a time', async () => {
    const { config } = await setup();
    const body = { operation: 'settings', channelIds: [ID(1), ID(2), ID(3)], params: { changes: { stealth: true } } };
    const result = await preview(config, body);
    const expect_ = Object.fromEntries(result.channels.map((channel) => [channel.channelId, channel.expect]));
    const first = await handleTunarrApi(post('/api/tunarr/batch/apply', { ...body, expect: expect_ }), config);
    const second = await handleTunarrApi(post('/api/tunarr/batch/apply', { ...body, expect: expect_ }), config);
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    await waitFor(config, read(first).id);
  });

  it('fingerprints only the fields a batch touches', () => {
    expect(settingsVersion({ groupTitle: 'a' })).not.toBe(settingsVersion({ groupTitle: 'b' }));
    expect(settingsVersion({ number: 1 })).toBe(settingsVersion({ number: 1 }));
  });
});
