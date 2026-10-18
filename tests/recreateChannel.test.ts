import { describe, expect, it, vi } from 'vitest';
import { programmingVersion } from '../server/lineupVersion';
import { redirectsTo, validateRecreate } from '../server/recreateChannel';
import { createProxyConfig, handleTunarrApi, type ProxyRequest } from '../server/tunarrProxy';

const OLD = 'a0000000-0000-4000-8000-000000000001';
const OTHER = 'a0000000-0000-4000-8000-000000000002';
const NEW = 'a0000000-0000-4000-8000-0000000000ff';
const schedule = { type: 'random', slots: [{ type: 'show', showId: 's1', weight: 1 }] };
const lineup = [
  { type: 'content', id: 'p1', duration: 1_800_000, persisted: true },
  { type: 'flex', duration: 0 },
  { type: 'flex', duration: 600_000, fillerConfig: { fillerListIds: ['f1'] } },
];

type Row = { channel: Record<string, unknown>; lineup: unknown[]; schedule?: unknown };

/** A small in-memory Tunarr: channels, their programming, create/copy/delete. */
function fakeTunarr(options: { failProgramming?: boolean; failDelete?: boolean; failPut?: boolean } = {}) {
  const rows = new Map<string, Row>([
    [OLD, { channel: { id: OLD, name: 'Cartoons', number: 4, startTime: 1000, icon: { path: 'logo.png' }, fillerCollections: [{ id: 'f1', weight: 1 }], subtitlePreferences: [{ language: 'en' }], programCount: 9, sessions: [], transcoding: {}, fallback: [] }, lineup, schedule }],
    [OTHER, { channel: { id: OTHER, name: 'Kids', number: 9 }, lineup: [{ type: 'redirect', channel: OLD, duration: 60_000 }] }],
  ]);
  const log: string[] = [];
  const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    log.push(`${method} ${path}`);
    if (path === '/api/channels' && method === 'GET') return reply([...rows.values()].map((row) => row.channel));
    if (path === '/api/channels' && method === 'POST') {
      if ([...rows.values()].some((row) => row.channel.number === payload.channel.number)) return reply('number taken', 500);
      rows.set(NEW, { channel: { ...payload.channel, id: NEW }, lineup: [] });
      return reply({ ...payload.channel, id: NEW }, 201);
    }
    const match = /^\/api\/channels\/([^/]+)(\/programming)?$/.exec(path);
    const row = match && rows.get(match[1]);
    if (!match || !row) return reply('not found', 404);
    if (match[2]) {
      if (method === 'POST') {
        if (options.failProgramming) return reply('Program p1 is missing', 400);
        row.lineup = payload.lineup;
        return reply({ lineup: row.lineup });
      }
      return reply({ lineup: row.lineup, schedule: row.schedule, programs: {} });
    }
    if (method === 'DELETE') {
      if (options.failDelete && match[1] === OLD) return reply('busy', 500);
      rows.delete(match[1]);
      return reply({});
    }
    if (method === 'PUT') {
      if (options.failPut) return reply('nope', 500);
      if ([...rows.entries()].some(([id, other]) => id !== match[1] && other.channel.number === payload.number)) return reply('number taken', 500);
      row.channel = payload;
      return reply(payload);
    }
    return reply(row.channel);
  });
  const config = { ...createProxyConfig({ TUNARR_URL: 'http://tunarr:8000' }), fetchImpl: fetchImpl as unknown as typeof fetch };
  return { rows, log, config, fetchImpl };
}

const version = programmingVersion(lineup, schedule);
const request = (method: string, data?: unknown, headers: ProxyRequest['headers'] = {}): ProxyRequest => ({
  method,
  url: `/api/tunarr/channels/${OLD}/recreate`,
  headers: { host: 'lineup.local:3000', origin: 'http://lineup.local:3000', 'content-type': 'application/json', 'if-match': `"${version}"`, ...headers },
  body: data === undefined ? undefined : JSON.stringify(data),
});
const parse = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));

describe('recreating a channel without its slot schedule', () => {
  it('keeps the lineup on a new manual channel with the same settings and number, then deletes the old one', async () => {
    const { rows, log, config } = fakeTunarr();
    const response = await handleTunarrApi(request('POST', { lineup: 'keep' }), config);
    expect(response.status).toBe(200);
    expect(parse(response)).toEqual({ id: NEW, number: 4, name: 'Cartoons', previousId: OLD });
    expect(rows.has(OLD)).toBe(false);
    const made = rows.get(NEW)!;
    expect(made.schedule).toBeUndefined();
    // Items passed through untouched, zero-length ones left out.
    expect(made.lineup).toEqual([lineup[0], lineup[2]]);
    expect(made.channel).toMatchObject({ name: 'Cartoons', number: 4, startTime: 1000, icon: { path: 'logo.png' }, fillerCollections: [{ id: 'f1', weight: 1 }], subtitlePreferences: [{ language: 'en' }] });
    for (const field of ['programCount', 'sessions', 'transcoding', 'fallback']) expect(made.channel).not.toHaveProperty(field);
    // Created on a free number first, so the old channel is whole until the copy is ready.
    expect(log.filter((line) => !line.startsWith('GET'))).toEqual(['POST /api/channels', `POST /api/channels/${NEW}/programming`, `DELETE /api/channels/${OLD}`, `PUT /api/channels/${NEW}`]);
  });

  it('makes an empty channel when asked, without saving a lineup', async () => {
    const { rows, log, config } = fakeTunarr();
    const response = await handleTunarrApi(request('POST', { lineup: 'empty' }), config);
    expect(response.status).toBe(200);
    expect(rows.get(NEW)!.lineup).toEqual([]);
    expect(log).not.toContain(`POST /api/channels/${NEW}/programming`);
  });

  it('refuses when the channel changed since it was loaded, and changes nothing', async () => {
    const { rows, log, config } = fakeTunarr();
    const response = await handleTunarrApi(request('POST', { lineup: 'keep' }, { 'if-match': '"stale"' }), config);
    expect(response.status).toBe(412);
    expect(parse(response).error.code).toBe('lineup_changed');
    expect(rows.has(OLD)).toBe(true);
    expect(log.every((line) => line.startsWith('GET'))).toBe(true);
  });

  it('removes the new channel and leaves the old one when Tunarr refuses the lineup', async () => {
    const { rows, config } = fakeTunarr({ failProgramming: true });
    const response = await handleTunarrApi(request('POST', { lineup: 'keep' }), config);
    expect(response.status).toBe(400);
    expect(parse(response).error.message).toMatch(/left as it was/);
    expect([...rows.keys()]).toEqual([OLD, OTHER]);
  });

  it('removes the new channel when the old one can’t be deleted', async () => {
    const { rows, config } = fakeTunarr({ failDelete: true });
    const response = await handleTunarrApi(request('POST', { lineup: 'empty' }), config);
    expect(response.status).toBe(502);
    expect(parse(response).error.message).toMatch(/left as it was/);
    expect([...rows.keys()]).toEqual([OLD, OTHER]);
  });

  it('reports the spare number when moving back to the old one fails', async () => {
    const { rows, config } = fakeTunarr({ failPut: true });
    const response = await handleTunarrApi(request('POST', { lineup: 'empty' }), config);
    expect(response.status).toBe(200);
    expect(parse(response)).toMatchObject({ id: NEW, number: 10 });
    expect(parse(response).numberError).toMatch(/recreated as 10, but couldn’t move back to 4/);
    expect(rows.get(NEW)!.channel.number).toBe(10);
  });

  it('requires If-Match and a valid body', async () => {
    const { config, fetchImpl } = fakeTunarr();
    expect((await handleTunarrApi(request('POST', { lineup: 'keep' }, { 'if-match': undefined }), config)).status).toBe(428);
    expect((await handleTunarrApi(request('POST', { lineup: 'all' }), config)).status).toBe(400);
    expect((await handleTunarrApi(request('POST', { lineup: 'keep', schedule: null }), config)).status).toBe(400);
    expect((await handleTunarrApi(request('POST', { lineup: 'keep' }, { origin: 'http://evil.example' }), config)).status).toBe(403);
    expect((await handleTunarrApi({ ...request('POST', { lineup: 'keep' }), url: '/api/tunarr/channels/..%2Fx/recreate' }, config)).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lists the channels that redirect here, without changing anything', async () => {
    const { log, config } = fakeTunarr();
    const response = await handleTunarrApi(request('GET'), config);
    expect(response.status).toBe(200);
    expect(parse(response)).toEqual({ redirects: [{ id: OTHER, number: 9, name: 'Kids' }] });
    expect(log.every((line) => line.startsWith('GET'))).toBe(true);
  });
});

describe('recreate helpers', () => {
  it('finds redirects in lineups and in slot schedules', () => {
    expect(redirectsTo({ lineup: [{ type: 'redirect', channel: OLD, duration: 1 }] }, OLD)).toBe(true);
    expect(redirectsTo({ lineup: [], schedule: { slots: [{ type: 'redirect', channelId: OLD }] } }, OLD)).toBe(true);
    expect(redirectsTo({ lineup: [{ type: 'redirect', channel: OTHER, duration: 1 }] }, OLD)).toBe(false);
    expect(redirectsTo(null, OLD)).toBe(false);
  });

  it('accepts only keep or empty', () => {
    expect(validateRecreate({ lineup: 'keep' })).toEqual({ lineup: 'keep' });
    expect(validateRecreate({ lineup: 'empty' })).toEqual({ lineup: 'empty' });
    expect(validateRecreate([])).toHaveProperty('error');
    expect(validateRecreate({})).toHaveProperty('error');
  });
});
