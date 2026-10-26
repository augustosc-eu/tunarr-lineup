import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addressAllowed, addressKind, buildPayload, destinationAllowed, createNotifier, postWebhook, readNotifySettings, shownWebhook, validateWebhookUrl, type Payload } from '../server/notify';
import { programmingVersion } from '../server/lineupVersion';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';
import { createScheduler } from '../server/scheduler';
import { checkChannels, controlRoomSummary } from '../server/controlRoom';

const servers: http.Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

/** A local webhook receiver; `respond` decides each reply. */
async function receiver(respond: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { bodies.push(data); respond(req, res); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, bodies };
}

describe('webhook addresses', () => {
  it('allows public addresses, private ones only when asked, and never loopback, link-local, metadata or multicast', () => {
    expect(addressAllowed('93.184.216.34', false)).toBe(true);
    expect(addressAllowed('2606:4700::1111', false)).toBe(true);
    for (const address of ['10.1.2.3', '172.20.0.5', '192.168.1.20', '100.100.1.1', 'fd12::1']) {
      expect([address, addressAllowed(address, false)]).toEqual([address, false]);
      expect([address, addressAllowed(address, true)]).toEqual([address, true]);
    }
    for (const address of ['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '0.0.0.0', '224.0.0.1', '::ffff:127.0.0.1', '::ffff:169.254.169.254']) {
      expect([address, addressAllowed(address, true)]).toEqual([address, false]);
    }
    expect(addressAllowed('::ffff:192.168.1.5', true)).toBe(true);
  });

  it('checks the address before anything is sent', () => {
    expect(validateWebhookUrl('https://hooks.example.com/abc?token=1', false)).toMatchObject({ url: expect.any(URL) });
    expect(validateWebhookUrl('http://hooks.example.com/abc', false)).toMatchObject({ error: expect.stringContaining('https://') });
    expect(validateWebhookUrl('http://192.168.1.20:8080/notify', true)).toMatchObject({ url: expect.any(URL) });
    expect(validateWebhookUrl('https://192.168.1.20/notify', false)).toMatchObject({ error: expect.stringContaining('isn’t public') });
    expect(validateWebhookUrl('https://user:pw@hooks.example.com/', false)).toMatchObject({ error: expect.stringContaining('credentials') });
    expect(validateWebhookUrl('https://hooks.example.com/#x', false)).toMatchObject({ error: expect.stringContaining('fragment') });
    expect(validateWebhookUrl('https://localhost/hook', true)).toMatchObject({ error: expect.any(String) });
    expect(validateWebhookUrl('https://metadata.google.internal/', true)).toMatchObject({ error: expect.any(String) });
    expect(validateWebhookUrl('https://127.0.0.1/hook', true)).toMatchObject({ error: expect.any(String) });
    expect(validateWebhookUrl('https://hooks.example.com:8443/', false)).toMatchObject({ error: expect.stringContaining('standard port') });
    expect(validateWebhookUrl('ftp://hooks.example.com/', true)).toMatchObject({ error: expect.any(String) });
    expect(shownWebhook('https://hooks.example.com/secret-path?token=abc')).toBe('hooks.example.com');
  });

  it('keeps a public destination on HTTPS port 443 even with the private-network option', () => {
    expect(validateWebhookUrl('https://hooks.example.com/abc', true)).toMatchObject({ url: expect.any(URL) });
    expect(validateWebhookUrl('https://hooks.example.com:443/abc', true)).toMatchObject({ url: expect.any(URL) });
    expect(validateWebhookUrl('http://93.184.216.34/token', false)).toMatchObject({ error: expect.any(String) });
    expect(validateWebhookUrl('http://93.184.216.34:8080/token', true)).toMatchObject({ error: expect.stringContaining('standard port (443)') });
    expect(validateWebhookUrl('https://93.184.216.34:8443/token', true)).toMatchObject({ error: expect.stringContaining('standard port (443)') });
    expect(validateWebhookUrl('http://hooks.example.com:8080/token', false)).toMatchObject({ error: expect.stringContaining('https://') });
    expect(validateWebhookUrl('https://hooks.example.com:8443/token', false)).toMatchObject({ error: expect.stringContaining('standard port') });
    // Private: refused without the option, allowed with it (http and any port).
    expect(validateWebhookUrl('http://192.168.1.20:8080/notify', false)).toMatchObject({ error: expect.any(String) });
    expect(validateWebhookUrl('http://192.168.1.20:8080/notify', true)).toMatchObject({ url: expect.any(URL) });
    expect(addressKind('93.184.216.34')).toBe('public');
    expect(addressKind('10.0.0.5')).toBe('private');
    expect(addressKind('169.254.169.254')).toBe('blocked');
  });
});

describe('delivering a notification', () => {
  const body = JSON.stringify({ hello: 'world' });

  it('never connects to a blocked address, whether written or resolved', async () => {
    const hook = await receiver((_req, res) => res.end());
    await expect(postWebhook(new URL(`http://127.0.0.1:${hook.port}/x`), body, { allowPrivate: true })).rejects.toMatchObject({ code: 'EBLOCKED' });
    const toPrivate = (_host: string, _options: unknown, callback: (error: null, addresses: Array<{ address: string; family: number }>) => void) => callback(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
    await expect(postWebhook(new URL('https://hooks.example.com/x'), body, { allowPrivate: false, lookupImpl: toPrivate })).rejects.toMatchObject({ code: 'EBLOCKED' });
    expect(hook.bodies).toEqual([]);
  });

  const resolvesTo = (...addresses: string[]) => (_host: string, _options: unknown, callback: (error: null, found: Array<{ address: string; family: number }>) => void) => callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));

  it('sends http:// or another port to a name only when it resolves to private addresses alone', async () => {
    const hook = await receiver((_req, res) => { res.statusCode = 200; res.end(); });
    // A public name over http:// or on another port: refused before connecting, option or not.
    const url = new URL(`http://hooks.example.com:${hook.port}/token`);
    await expect(postWebhook(url, body, { allowPrivate: true, lookupImpl: resolvesTo('93.184.216.34') })).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(postWebhook(new URL('https://hooks.example.com:8443/token'), body, { allowPrivate: true, lookupImpl: resolvesTo('93.184.216.34') })).rejects.toMatchObject({ code: 'EBLOCKED' });
    // Public and private at once: refused, even over HTTPS on 443 with the option.
    await expect(postWebhook(new URL('https://hooks.example.com/token'), body, { allowPrivate: true, lookupImpl: resolvesTo('93.184.216.34', '192.168.1.20') })).rejects.toMatchObject({ code: 'EBLOCKED' });
    await expect(postWebhook(url, body, { allowPrivate: true, lookupImpl: resolvesTo('192.168.1.20', '93.184.216.34') })).rejects.toMatchObject({ code: 'EBLOCKED' });
    // Private only, without the option: refused.
    await expect(postWebhook(url, body, { allowPrivate: false, lookupImpl: resolvesTo('192.168.1.20') })).rejects.toMatchObject({ code: 'EBLOCKED' });
    expect(hook.bodies).toEqual([]);
    // Private only, with the option: sent (loopback stands in for the private address here).
    const privateOnly = { allowPrivate: true, lookupImpl: resolvesTo('127.0.0.1'), classify: (address: string) => (address === '127.0.0.1' ? 'private' as const : addressKind(address)) };
    expect(await postWebhook(new URL(`http://ntfy.lan:${hook.port}/token`), body, privateOnly)).toEqual({ status: 200 });
    expect(hook.bodies).toEqual([body]);
  });

  it('decides a resolved destination: public on HTTPS 443, private only with the option, never mixed', () => {
    const https443 = new URL('https://hooks.example.com/x');
    const plain = new URL('http://hooks.example.com/x');
    const otherPort = new URL('https://hooks.example.com:8443/x');
    expect(destinationAllowed(['public'], https443, false)).toBe(true);
    expect(destinationAllowed(['public', 'public'], https443, true)).toBe(true);
    expect(destinationAllowed(['public'], plain, true)).toBe(false);
    expect(destinationAllowed(['public'], otherPort, true)).toBe(false);
    expect(destinationAllowed(['private'], plain, false)).toBe(false);
    expect(destinationAllowed(['private'], plain, true)).toBe(true);
    expect(destinationAllowed(['private'], otherPort, true)).toBe(true);
    expect(destinationAllowed(['public', 'private'], https443, true)).toBe(false);
    expect(destinationAllowed(['private', 'blocked'], plain, true)).toBe(false);
    expect(destinationAllowed([], https443, true)).toBe(false);
  });

  it('connects to the address it checked (the lookup is pinned), and reports the status', async () => {
    const hook = await receiver((_req, res) => { res.statusCode = 204; res.end(); });
    const pinned = (_host: string, _options: unknown, callback: (error: null, addresses: Array<{ address: string; family: number }>) => void) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
    const result = await postWebhook(new URL(`http://hook.test:${hook.port}/notify`), body, { allowPrivate: true, lookupImpl: pinned, classify: (address) => (address === '127.0.0.1' ? 'private' : 'blocked') });
    expect(result).toEqual({ status: 204 });
    expect(hook.bodies).toEqual([body]);
  });

  it('refuses redirects (never following one to a blocked address), gives up on slow servers, and caps the reply it reads', async () => {
    // The test receivers listen on loopback; treat it as the owner's private network.
    const classify = () => 'private' as const;
    const redirect = await receiver((_req, res) => { res.statusCode = 302; res.setHeader('location', 'http://169.254.169.254/'); res.end(); });
    await expect(postWebhook(new URL(`http://127.0.0.1:${redirect.port}/`), body, { allowPrivate: true, classify })).rejects.toMatchObject({ code: 'EREDIRECT' });
    const slow = await receiver(() => { /* never answers */ });
    await expect(postWebhook(new URL(`http://127.0.0.1:${slow.port}/`), body, { allowPrivate: true, classify, timeoutMs: 100 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    const big = await receiver((_req, res) => { res.statusCode = 200; res.end('x'.repeat(1_000_000)); });
    expect(await postWebhook(new URL(`http://127.0.0.1:${big.port}/`), body, { allowPrivate: true, classify })).toEqual({ status: 200 });
  });
});

describe('the message', () => {
  const notice = { event: 'scheduled.skipped' as const, severity: 'warning' as const, summary: 'A scheduled change was skipped.', named: '“Halloween” was skipped on CH 5 Desk News.', channel: { id: 'c5', number: 5, name: 'Desk News' } };

  it('is small and versioned, and names nothing unless the owner opted in', () => {
    const plain = buildPayload(notice, false, Date.UTC(2026, 9, 31), 'id-1');
    expect(plain).toEqual({ schema: 'tunarr-lineup.notification', version: 1, id: 'id-1', event: 'scheduled.skipped', severity: 'warning', at: '2026-10-31T00:00:00.000Z', summary: 'A scheduled change was skipped.', channel: { id: 'c5', number: 5 } });
    expect(buildPayload(notice, true)).toMatchObject({ summary: '“Halloween” was skipped on CH 5 Desk News.', channel: { name: 'Desk News' } });
    expect(JSON.stringify(plain).length).toBeLessThan(400);
  });
});

describe('the notifier', () => {
  const env = (extra: Record<string, string> = {}) => ({ LINEUP_NOTIFY_URL: 'https://hooks.example.com/abc', ...extra });

  it('is off without an address, and says why an address can’t be used', () => {
    expect(readNotifySettings({}).settings).toBeNull();
    expect(readNotifySettings({ LINEUP_NOTIFY_URL: 'http://hooks.example.com/' })).toMatchObject({ settings: null, problem: expect.stringContaining('https://') });
    expect([...readNotifySettings(env()).settings!.events]).toEqual(['scheduled.skipped', 'scheduled.failed', 'scheduled.missed', 'channel.unhealthy', 'guide.failed', 'batch.partial']);
    expect([...readNotifySettings(env({ LINEUP_NOTIFY_EVENTS: 'save.conflict,bogus' })).settings!.events]).toEqual(['save.conflict']);
  });

  it('sends only chosen events, deduplicates, retries a failing service a bounded number of times, and records results without the address', async () => {
    const sent: Payload[] = [];
    const statuses = [500, 503, 200];
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const notifier = createNotifier(env(), { sleep, send: async (_url, body) => { sent.push(JSON.parse(body)); return { status: statuses.shift() ?? 200 }; } });
    notifier.notify({ event: 'scheduled.applied', severity: 'info', summary: 'off by default' });
    notifier.notify({ event: 'guide.failed', severity: 'warning', summary: 'guide', dedupe: { key: 'guide', ms: 60_000 } });
    notifier.notify({ event: 'guide.failed', severity: 'warning', summary: 'guide again', dedupe: { key: 'guide', ms: 60_000 } });
    await notifier.idle();
    expect(sent.map((payload) => payload.summary)).toEqual(['guide', 'guide', 'guide']);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 10_000]);
    expect(notifier.recent()).toEqual([expect.objectContaining({ event: 'guide.failed', ok: true, status: 200, attempts: 3 })]);
    expect(JSON.stringify(notifier.recent())).not.toContain('hooks.example.com');
  });

  it('doesn’t retry a refused request or a blocked address', async () => {
    let calls = 0;
    const rejecting = createNotifier(env(), { sleep: async () => undefined, send: async () => { calls += 1; return { status: 400 }; } });
    expect(await rejecting.test()).toMatchObject({ ok: false, status: 400, attempts: 1 });
    const blocked = createNotifier(env(), { send: async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'EBLOCKED' }); } });
    expect(await blocked.test()).toMatchObject({ ok: false, attempts: 1, error: 'The address (or what it resolves to) isn’t allowed.' });
    expect(calls).toBe(2);
  });
});

// ------------------------------------------------------- events in the companion

describe('notifications from the companion', () => {
  async function setup(extraEnv: Record<string, string> = {}) {
    const sent: Payload[] = [];
    const dir = await mkdtemp(path.join(tmpdir(), 'lineup-notify-'));
    const config: ProxyConfig = createProxyConfig({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://secret-tunarr.lan:8000' });
    config.notifier = createNotifier({ LINEUP_NOTIFY_URL: 'https://hooks.example.com/x', LINEUP_NOTIFY_EVENTS: 'scheduled.applied,scheduled.skipped,save.conflict,batch.partial,channel.unhealthy,media.missing,guide.failed', ...extraEnv }, { send: async (_url, body) => { sent.push(JSON.parse(body)); return { status: 200 }; } });
    const state = { lineup: [{ type: 'content', id: '0b6f5c4e-1a2b-4c3d-8e9f-000000000001', duration: 60_000 }] as unknown[] };
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    config.fetchImpl = (async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      if (url.pathname === '/api/channels') return json([{ id: 'c1', number: 1, name: 'Desk News' }]);
      if (url.pathname === '/api/guide/channels') return new Response('nope', { status: 500 });
      if (url.pathname.endsWith('/programming')) {
        if (init.method === 'POST') state.lineup = JSON.parse(String(init.body)).lineup;
        return json({ lineup: state.lineup, programs: {} });
      }
      if (url.pathname === '/api/channels/c1') return json({ id: 'c1', number: 1, name: 'Desk News', startTime: 0, fillerCollections: [] });
      return json([]);
    }) as unknown as typeof fetch;
    return { config, sent, state, dir };
  }
  const text = (sent: Payload[]) => JSON.stringify(sent);

  it('tells the owner about scheduled changes and refused saves, without Tunarr’s address or reasons', async () => {
    const { config, sent, dir } = await setup();
    const scheduler = createScheduler(config, { enabled: true, dataDir: dir, snapshots: config.snapshots });
    const now = Date.now();
    await scheduler.store.add({ group: 'save', changes: [
      { channelId: 'c1', channelName: 'CH 1 Desk News', label: 'Evening', at: now - 1000, action: { kind: 'lineup', lineup: [{ type: 'flex', duration: 60_000 }], expectVersion: programmingVersion([{ type: 'content', id: '0b6f5c4e-1a2b-4c3d-8e9f-000000000001', duration: 60_000 }], undefined) }, programs: {} },
    ] });
    await scheduler.store.add({ group: 'save', changes: [{ channelId: 'c1', channelName: 'CH 1 Desk News', label: 'Stale', at: now - 500, action: { kind: 'lineup', lineup: [{ type: 'flex', duration: 1000 }], expectVersion: 'stale' }, programs: {} }] });
    await scheduler.runDue(now);
    const save = await handleTunarrApi({ method: 'POST', url: '/api/tunarr/channels/c1/programming', headers: { host: 'lineup.local', 'content-type': 'application/json', 'if-match': '"old"' }, body: JSON.stringify({ type: 'manual', append: false, lineup: [{ type: 'flex', duration: 1000 }] }) }, config);
    expect(save.status).toBe(412);
    await config.notifier!.idle();
    expect(sent.map((payload) => payload.event)).toEqual(['scheduled.applied', 'scheduled.skipped', 'save.conflict']);
    expect(sent[1].summary).toBe('A scheduled change was skipped. See File → Scheduled Changes in the desk for why.');
    for (const secret of ['secret-tunarr', 'Desk News', 'Evening', 'changed after this was planned']) expect(text(sent)).not.toContain(secret);
  });

  it('names channels and changes only with the opt-in', async () => {
    const { config, sent, dir } = await setup({ LINEUP_NOTIFY_NAMES: 'on' });
    const scheduler = createScheduler(config, { enabled: true, dataDir: dir, snapshots: config.snapshots });
    await scheduler.store.add({ group: 'save', changes: [{ channelId: 'c1', channelName: 'CH 1 Desk News', label: 'Stale', at: Date.now() - 500, action: { kind: 'lineup', lineup: [{ type: 'flex', duration: 1000 }], expectVersion: 'stale' }, programs: {} }] });
    await scheduler.runDue(Date.now());
    await config.notifier!.idle();
    expect(sent[0]).toMatchObject({ summary: '“Stale” was skipped on CH 1 Desk News. See File → Scheduled Changes for why.', channel: { id: 'c1', name: 'CH 1 Desk News' } });
    expect(text(sent)).not.toContain('secret-tunarr');
  });

  it('reports unhealthy channels and missing media once, and a failing guide at most hourly', async () => {
    const { config, sent } = await setup();
    const target = config.target!;
    await checkChannels(config, target, ['c1']);
    await checkChannels(config, target, ['c1']);
    await controlRoomSummary(config, target);
    await controlRoomSummary(config, target);
    await config.notifier!.idle();
    expect(sent.map((payload) => payload.event)).toEqual(['channel.unhealthy', 'media.missing', 'guide.failed']);
    expect(sent[0]).toMatchObject({ severity: 'error', channel: { id: 'c1', number: 1 }, counts: { errors: 1 }, summary: 'A Control Room check found 1 error on channel 1.' });
    expect(sent[1]).toMatchObject({ counts: { programs: 1 } });
  });
});
