import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLineupServer } from '../server/app';
import { programmingVersion } from '../server/lineupVersion';
import { ROLE_FOLDERS } from '../server/mediaFolder';
import { parseRange } from '../server/nodeAdapter';
import { validateDraft } from '../server/sharedDraftStore';
import { createSnapshotStore, MAX_SNAPSHOTS_PER_CHANNEL } from '../server/snapshotStore';
import { createProxyConfig, handleTunarrApi, type ProxyConfig, type ProxyRequest } from '../server/tunarrProxy';

const tempDir = (name: string) => mkdtemp(path.join(tmpdir(), `lineup-${name}-`));
const A = { type: 'content', id: 'a0000000-0000-4000-8000-000000000001', duration: 60_000 };
const B = { type: 'content', id: 'a0000000-0000-4000-8000-000000000002', duration: 60_000 };
const programs = { [A.id]: { id: A.id, program: { type: 'episode', title: 'Pilot', show: { title: 'Bravo' }, episodeNumber: 1, seasonNumber: 1, actors: ['x'], summary: 'long' } } };
const request = (method: string, url: string, body?: unknown, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({
  method, url, headers: { host: 'lineup.local', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

describe('snapshots', () => {
  it('keeps a lineup with slim titles, skips repeats of the same version, and caps how many are kept', async () => {
    const store = createSnapshotStore(await tempDir('snapshots'));
    const first = await store.take('chan-1', { lineup: [A, B], programs }, 'Before a lineup save');
    expect(first).toMatchObject({ items: 2, length: 120_000, hadSchedule: false });
    expect(await store.take('chan-1', { lineup: [A, B], programs }, 'again')).toBeNull();
    const full = await store.get('chan-1', first!.id);
    expect(full?.programs[A.id]).toEqual({ type: 'episode', title: 'Pilot', episodeNumber: 1, seasonNumber: 1, show: { title: 'Bravo' } });
    for (let index = 0; index < MAX_SNAPSHOTS_PER_CHANNEL + 3; index += 1) await store.take('chan-1', { lineup: [{ ...A, duration: 1000 + index }] }, `v${index}`);
    const list = await store.list('chan-1');
    expect(list).toHaveLength(MAX_SNAPSHOTS_PER_CHANNEL);
    expect(list[0].reason).toBe(`v${MAX_SNAPSHOTS_PER_CHANNEL + 2}`);
  });

  it('moves a recreated channel’s snapshots to its new id', async () => {
    const store = createSnapshotStore(await tempDir('snapshots'));
    await store.take('old-id', { lineup: [A] }, 'one');
    await store.moveChannel('old-id', 'new-id');
    expect(await store.list('old-id')).toEqual([]);
    expect((await store.list('new-id'))[0]).toMatchObject({ channelId: 'new-id', reason: 'one' });
  });

  it('takes one before every save through the proxy, and serves them', async () => {
    const dataDir = await tempDir('snapshots');
    let lineup: unknown[] = [A, B];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') lineup = (JSON.parse(String(init.body)) as { lineup: unknown[] }).lineup;
      return new Response(JSON.stringify({ lineup, programs }), { status: 200 });
    });
    const config: ProxyConfig = { ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000', LINEUP_DATA_DIR: dataDir }), fetchImpl: fetchImpl as unknown as typeof fetch };
    const saved = await handleTunarrApi(request('POST', '/api/tunarr/channels/chan-1/programming', { type: 'manual', lineup: [B, A], append: false }, { 'if-match': `"${programmingVersion([A, B], undefined)}"` }), config);
    expect(saved.status).toBe(200);
    const list = json(await handleTunarrApi(request('GET', '/api/tunarr/channels/chan-1/snapshots'), config));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'Before a lineup save', items: 2 });
    const one = json(await handleTunarrApi(request('GET', `/api/tunarr/channels/chan-1/snapshots/${list[0].id}`), config));
    expect(one.lineup).toEqual([A, B]);
    expect((await handleTunarrApi(request('GET', '/api/tunarr/channels/chan-1/snapshots/not-a-uuid'), config)).status).toBe(400);
    expect((await handleTunarrApi(request('GET', '/api/tunarr/channels/..%2F/snapshots'), config)).status).toBe(400);
    // Taken by hand, from Tunarr's current copy.
    expect((await handleTunarrApi(request('POST', '/api/tunarr/channels/chan-1/snapshots', {}), config)).status).toBe(201);
  });
});

describe('shared drafts', () => {
  const draft = { channelId: 'chan-1', version: 'abc-def-12', dirty: true, current: [1, 0], past: [{ label: 'Moved', before: [0, 1], after: [1, 0], blockBefore: { start: 0, end: 0 }, blockAfter: { start: 1, end: 1 } }], future: [] };

  it('checks a draft’s shape without trusting it', () => {
    expect(validateDraft(draft, 'chan-1')).toHaveProperty('draft');
    expect(validateDraft(draft, 'chan-2')).toHaveProperty('error');
    expect(validateDraft({ ...draft, current: [-1] }, 'chan-1')).toHaveProperty('error');
    expect(validateDraft({ ...draft, past: [{ label: 'x' }] }, 'chan-1')).toHaveProperty('error');
    expect(validateDraft({ ...draft, extras: [{ type: 'content', duration: 1 }] }, 'chan-1')).toHaveProperty('error');
    expect(validateDraft({ ...draft, version: '../x' }, 'chan-1')).toHaveProperty('error');
  });

  it('stores, lists and deletes drafts through the companion', async () => {
    const config = createProxyConfig({ LINEUP_DATA_DIR: await tempDir('drafts') });
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/drafts/chan-1', draft), config)).status).toBe(200);
    expect(json(await handleTunarrApi(request('GET', '/api/tunarr/drafts'), config))).toEqual([expect.objectContaining({ channelId: 'chan-1', version: 'abc-def-12', dirty: true })]);
    expect(json(await handleTunarrApi(request('GET', '/api/tunarr/drafts/chan-1'), config))).toMatchObject({ current: [1, 0], past: draft.past });
    expect((await handleTunarrApi(request('DELETE', '/api/tunarr/drafts/chan-1'), config)).status).toBe(200);
    const gone = await handleTunarrApi(request('GET', '/api/tunarr/drafts/chan-1'), config);
    expect(gone.status).toBe(200);
    expect(json(gone)).toBeNull();
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/drafts/chan-1', draft, { origin: 'http://evil.example' }), config)).status).toBe(403);
  });
});

describe('media playback', () => {
  it('parses one byte range, a suffix, or nothing', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=2000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 1000)).toBeNull();
    expect(parseRange(undefined, 1000)).toBeNull();
  });

  it('streams a media-folder file with ranges and refuses anything outside it', async () => {
    const media = await tempDir('media');
    // The role folder's real name: Linux file systems are case-sensitive.
    await mkdir(path.join(media, ROLE_FOLDERS.commercials), { recursive: true });
    await writeFile(path.join(media, ROLE_FOLDERS.commercials, 'spot.mp4'), Buffer.from('0123456789'));
    const server = createLineupServer({ config: createProxyConfig({ LINEUP_MEDIA_DIR: media, LINEUP_DATA_DIR: await tempDir('data') }), auth: null, staticRoot: await tempDir('static') });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tunarr/media-folder`;
    try {
      const whole = await fetch(`${base}/commercials/spot.mp4`);
      expect(whole.status).toBe(200);
      expect(whole.headers.get('content-type')).toBe('video/mp4');
      expect(await whole.text()).toBe('0123456789');
      const part = await fetch(`${base}/commercials/spot.mp4`, { headers: { range: 'bytes=2-4' } });
      expect(part.status).toBe(206);
      expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
      expect(await part.text()).toBe('234');
      expect((await fetch(`${base}/commercials/missing.mp4`)).status).toBe(404);
      expect((await fetch(`${base}/commercials/..%2F..%2Fsecret.mp4`)).status).toBe(400);
      expect((await fetch(`${base}/nope/spot.mp4`)).status).toBe(400);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('AI review', () => {
  it('asks the model with the review tool and returns bounded text', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tool_choice: { name: string }; messages: Array<{ content: string }> };
      expect(body.tool_choice.name).toBe('review_schedule');
      expect(body.messages[0].content).toContain('Same episode twice');
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', input: { summary: 'Solid prime time.', suggestions: [{ title: 'Move cartoons', detail: 'Mornings.', priority: 'urgent' }] } }] }), { status: 200 });
    });
    const config = createProxyConfig({ LINEUP_DATA_DIR: await tempDir('ai'), LINEUP_AI_PROVIDER: 'anthropic', LINEUP_AI_API_KEY: 'k' });
    (config.ai as { fetchImpl?: typeof fetch }).fetchImpl = fetchImpl as unknown as typeof fetch;
    const response = await handleTunarrApi(request('POST', '/api/tunarr/ai/review', { channelName: 'One', summary: 'Mon 20:00 Drama', issues: ['Same episode twice on Monday'] }), config);
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ summary: 'Solid prime time.', suggestions: [{ title: 'Move cartoons', detail: 'Mornings.', priority: 'medium' }] });
    expect((await handleTunarrApi(request('POST', '/api/tunarr/ai/review', { summary: '' }), config)).status).toBe(400);
  });
});
