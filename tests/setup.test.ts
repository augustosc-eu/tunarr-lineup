import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createLineupServer } from '../server/app';
import { APP_USER, authorize, hashPassword, validateAccount, verifyPassword } from '../server/auth';
import { bootCompanion } from '../server/boot';
import { configEnv, createConfigStore, importEnv, parseStoredConfig, type StoredConfig } from '../server/configStore';
import { createSetup, newSetupCode } from '../server/setup';
import { createProxyConfig, handleTunarrApi, type ProxyRequest } from '../server/tunarrProxy';

const tempDir = (name: string) => mkdtemp(path.join(tmpdir(), `lineup-${name}-`));
const CODE = 'ABCDE-FGHJK';
const request = (method: string, url: string, body?: unknown): ProxyRequest => ({
  method, url, headers: { host: 'lineup.local', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
});
const json = (response: { body: string | Uint8Array }) => JSON.parse(typeof response.body === 'string' ? response.body : new TextDecoder().decode(response.body));
const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** A Tunarr that answers only at tunarr:8000 and 192.168.1.20:8000. */
const fakeTunarr = (async (url: string) => {
  const parsed = new URL(url);
  if (!['tunarr:8000', '192.168.1.20:8000'].includes(parsed.host)) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  if (parsed.pathname === '/api/channels') return new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response('{}', { status: 404 });
}) as unknown as typeof fetch;

async function setupServer(stored: Partial<StoredConfig> = {}, options: { now?: () => number; appKey?: string } = {}) {
  const dir = await tempDir('setup');
  const store = createConfigStore(dir);
  const initial: StoredConfig = { version: 1, setupComplete: false, values: {}, ...stored };
  const env = { LINEUP_DATA_DIR: dir };
  const setup = createSetup({ store, stored: initial, processEnv: env, dataDir: dir, code: CODE, ...options });
  const config = createProxyConfig(configEnv(env, initial.values));
  config.setup = setup;
  config.fetchImpl = fakeTunarr;
  return { dir, store, setup, config };
}

const finishBody = (extra: Record<string, unknown> = {}) => ({ code: CODE, tunarrUrl: 'http://tunarr:8000', account: { username: 'ops', password: 'correct horse' }, ...extra });

describe('passwords and sign-in', () => {
  it('hashes with scrypt and checks without keeping the password', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash.scheme).toBe('scrypt');
    expect(JSON.stringify(hash)).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect((await hashPassword('correct horse')).hash).not.toBe(hash.hash);
  });

  it('signs in with a hashed account, and the desktop window with its app key', async () => {
    const auth = { username: 'ops', passwordHash: await hashPassword('correct horse'), appKey: 'k'.repeat(32) };
    expect(await authorize(basic('ops', 'correct horse'), auth)).toBe(true);
    expect(await authorize(basic('ops', 'correct horse'), auth)).toBe(true);
    expect(await authorize(basic('ops', 'wrong'), auth)).toBe(false);
    expect(await authorize(basic('admin', 'correct horse'), auth)).toBe(false);
    expect(await authorize(basic(APP_USER, 'k'.repeat(32)), auth)).toBe(true);
    expect(await authorize(basic(APP_USER, 'nope'), auth)).toBe(false);
    expect(await authorize(undefined, auth)).toBe(false);
    expect(await authorize(undefined, null)).toBe(true);
  });

  it('checks the account the wizard makes', () => {
    expect(validateAccount('ops', 'correct horse')).toEqual({ username: 'ops', password: 'correct horse' });
    expect(validateAccount('', 'correct horse')).toHaveProperty('error');
    expect(validateAccount('o p s', 'correct horse')).toHaveProperty('error');
    expect(validateAccount(APP_USER, 'correct horse')).toHaveProperty('error');
    expect(validateAccount('ops', 'short')).toHaveProperty('error');
    expect(validateAccount('ops', 'line\nbreak!')).toHaveProperty('error');
  });

  it('checks a flood of wrong passwords a couple at a time, and still signs the right one in', async () => {
    const auth = { username: 'ops', passwordHash: await hashPassword('correct horse') };
    const results = await Promise.all([...Array.from({ length: 8 }, (_, i) => authorize(basic('ops', `wrong ${i}`), auth)), authorize(basic('ops', 'correct horse'), auth)]);
    expect(results).toEqual([...Array(8).fill(false), true]);
  });

  it('makes readable setup codes', () => {
    const code = newSetupCode();
    expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(code).not.toMatch(/[01OIL]/);
  });
});

describe('config.json', () => {
  it('copies the environment once, with the password hashed and provider keys renamed', async () => {
    const stored = await importEnv({ TUNARR_URL: 'http://tunarr:8000', LINEUP_PASSWORD: 'hunter22', LINEUP_USERNAME: 'desk', ANTHROPIC_API_KEY: 'sk-ant', LINEUP_SCHEDULER: 'on', PORT: '3000' });
    expect(stored.setupComplete).toBe(true);
    expect(stored.values).toEqual({ TUNARR_URL: 'http://tunarr:8000', LINEUP_SCHEDULER: 'on', LINEUP_AI_API_KEY: 'sk-ant', LINEUP_AI_PROVIDER: 'anthropic' });
    expect(stored.account?.username).toBe('desk');
    expect(JSON.stringify(stored)).not.toContain('hunter22');
    expect(stored.importedFromEnv).toEqual(expect.arrayContaining(['TUNARR_URL', 'ANTHROPIC_API_KEY', 'LINEUP_PASSWORD', 'LINEUP_USERNAME']));
    // Without a password, setup still runs, with the address filled in.
    expect((await importEnv({ TUNARR_URL: 'http://tunarr:8000' })).setupComplete).toBe(false);
    expect((await importEnv({})).setupComplete).toBe(false);
  });

  it('replaces configuration keys in the environment the server reads, and keeps the rest', () => {
    const env = configEnv({ TUNARR_URL: 'http://old:8000', LINEUP_PASSWORD: 'x', OPENAI_API_KEY: 'y', PORT: '3000', LINEUP_DATA_DIR: '/data' }, { TUNARR_URL: 'http://new:8000' });
    expect(env).toEqual({ TUNARR_URL: 'http://new:8000', PORT: '3000', LINEUP_DATA_DIR: '/data' });
  });

  it('keeps only known keys from the file and refuses one that isn’t a configuration', () => {
    expect(parseStoredConfig({ version: 1, setupComplete: true, values: { TUNARR_URL: 'http://t:8000', HOST: '0.0.0.0', LINEUP_AI_API_KEY: 5 } })).toEqual({ version: 1, setupComplete: false, values: { TUNARR_URL: 'http://t:8000' } });
    expect(parseStoredConfig(undefined)).toBeUndefined();
    expect(() => parseStoredConfig({ version: 2 })).toThrow(/config.json/);
  });

  it('is written owner-only', async () => {
    const dir = await tempDir('config');
    const store = createConfigStore(dir);
    await store.write(await importEnv({ TUNARR_URL: 'http://tunarr:8000', LINEUP_PASSWORD: 'hunter22' }));
    const info = await stat(path.join(dir, 'config.json'));
    if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(dir, 'config.json'), 'utf8')).not.toContain('hunter22');
  });

  it('boots from the environment the first time and from config.json after that', async () => {
    const dir = await tempDir('boot');
    const first = await bootCompanion({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://tunarr:8000', LINEUP_PASSWORD: 'hunter22', LINEUP_SCHEDULER: 'off' });
    expect(first.setup.needed()).toBe(false);
    expect(first.config.target?.host).toBe('tunarr:8000');
    expect(first.notes[0]).toMatch(/Copied TUNARR_URL/);
    const second = await bootCompanion({ LINEUP_DATA_DIR: dir, TUNARR_URL: 'http://elsewhere:8000', LINEUP_SCHEDULER: 'off' });
    expect(second.config.target?.host).toBe('tunarr:8000');
    expect(second.notes[0]).toMatch(/Ignoring TUNARR_URL/);
    first.config.scheduler?.stop();
    second.config.scheduler?.stop();
  });

  it('moves an AI model saved from the desk into AI setup, once', async () => {
    const dir = await tempDir('boot-model');
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { LINEUP_AI_MODEL: 'llama3', TUNARR_TIMEOUT_MS: '20000' } }));
    const booted = await bootCompanion({ LINEUP_DATA_DIR: dir, LINEUP_AI_PROVIDER: 'openai', LINEUP_AI_BASE_URL: 'http://ollama:11434/v1' });
    expect(booted.setup.stored().values.LINEUP_AI_MODEL).toBe('llama3');
    expect(booted.config.ai).toMatchObject({ provider: 'openai', model: 'llama3' });
    expect(booted.config.timeoutMs).toBe(20_000);
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).values).toEqual({ TUNARR_TIMEOUT_MS: '20000' });
  });
});

describe('setup wizard routes', () => {
  it('answers nothing else until setup is done', async () => {
    const { config } = await setupServer();
    const health = await handleTunarrApi(request('GET', '/api/tunarr/health'), config);
    expect(health.status).toBe(503);
    expect(json(health)).toMatchObject({ status: 'setup_required' });
    for (const [method, url] of [['GET', '/api/tunarr/channels'], ['GET', '/api/tunarr/templates'], ['GET', '/api/tunarr/server-config'], ['GET', '/api/tunarr/server-settings']]) {
      expect((await handleTunarrApi(request(method, url), config)).status).toBe(503);
    }
    expect(json(await handleTunarrApi(request('GET', '/api/tunarr/setup'), config))).toEqual({ needed: true });
  });

  it('needs the setup code, and stops answering after five wrong ones', async () => {
    let now = 1_000_000;
    const { config } = await setupServer({}, { now: () => now });
    const wrong = await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: 'XXXXX-XXXXX' }), config);
    expect(wrong.status).toBe(403);
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/detect', {}), config)).status).toBe(403);
    // Typed in lower case and without the dash still counts.
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: 'abcdefghjk' }), config)).status).toBe(200);
    for (let i = 0; i < 5; i += 1) await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: 'nope' }), config);
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: CODE }), config)).status).toBe(429);
    now += 61_000;
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: CODE }), config)).status).toBe(200);
  });

  it('finds Tunarr in the usual places and tests a typed address', async () => {
    const { config } = await setupServer();
    const detected = json(await handleTunarrApi(request('POST', '/api/tunarr/setup/detect', { code: CODE }), config));
    expect(detected.found).toEqual([{ url: 'http://tunarr:8000', host: 'tunarr:8000', ok: true, channelCount: 2 }]);
    expect(detected.tried).toEqual(expect.arrayContaining(['localhost:8000', 'tunarr:8000', 'host.docker.internal:8000']));
    // No scheme typed: http:// is assumed.
    // A working address also says what that Tunarr can do (read-only checks; this one has no version route).
    expect(json(await handleTunarrApi(request('POST', '/api/tunarr/setup/test', { code: CODE, tunarrUrl: '192.168.1.20:8000' }), config))).toMatchObject({ ok: true, channelCount: 2, compatibility: { version: null, versionStatus: 'unknown' } });
    expect(json(await handleTunarrApi(request('POST', '/api/tunarr/setup/test', { code: CODE, tunarrUrl: 'http://nowhere:8000' }), config))).toMatchObject({ ok: false, message: expect.stringMatching(/Could not reach Tunarr at nowhere:8000/) });
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/test', { code: CODE, tunarrUrl: 'ftp://x' }), config)).status).toBe(400);
  });

  it('finishes setup: saves config.json, points the server at Tunarr and turns sign-in on', async () => {
    const { config, setup, dir } = await setupServer();
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ account: { username: 'ops', password: 'short' } })), config)).status).toBe(400);
    expect(setup.needed()).toBe(true);
    const done = await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ ai: { provider: 'openai', baseUrl: 'http://ollama:11434/v1', model: 'llama3.1' }, options: { scheduler: false, externalLogos: false } })), config);
    expect(done.status).toBe(200);
    expect(setup.needed()).toBe(false);
    expect(config.target?.host).toBe('tunarr:8000');
    expect(config.ai).toMatchObject({ provider: 'openai', model: 'llama3.1' });
    expect(config.externalLogos).toBe(false);
    expect(setup.auth()?.username).toBe('ops');
    const file = await readFile(path.join(dir, 'config.json'), 'utf8');
    expect(file).not.toContain('correct horse');
    expect(JSON.parse(file)).toMatchObject({ setupComplete: true, values: { TUNARR_URL: 'http://tunarr:8000' } });
    // Now the desk works, and the wizard is closed.
    expect(json(await handleTunarrApi(request('GET', '/api/tunarr/health'), config))).toMatchObject({ status: 'connected', channelCount: 2 });
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: CODE }), config)).status).toBe(409);
  });

  it('checks AI and the media folder before saving', async () => {
    const { config, dir } = await setupServer();
    const media = await tempDir('setup-media');
    for (const extra of [
      { ai: { provider: 'anthropic' } },
      { ai: { provider: 'openai' } },
      { ai: { provider: 'other' } },
      { ai: { provider: 'openai', model: 'm', baseUrl: 'file:///etc' } },
      { media: { dir: 'relative/path' } },
      { media: { dir: path.join(media, 'missing') } },
      { media: { dir } },
      { media: { dir: path.dirname(dir) } },
      { media: { dir: media, tunarrDir: 'not/full' } },
    ]) {
      expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody(extra)), config)).status, JSON.stringify(extra)).toBe(400);
    }
    // A link into the data folder counts as the data folder.
    const link = path.join(media, 'sneaky');
    await symlink(dir, link);
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ media: { dir: link } })), config)).status).toBe(400);
    const ok = await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ media: { dir: media, tunarrDir: '/media/lineup' } })), config);
    expect(ok.status).toBe(200);
    expect(config.mediaFolder && !('off' in config.mediaFolder) && config.mediaFolder.tunarrPath('station-id')).toMatch(/^\/media\/lineup\//);
  });

  it('prefills the wizard from an imported address, without its credentials', async () => {
    const { config } = await setupServer({ values: { TUNARR_URL: 'http://admin:s3cret@tunarr:8000', LINEUP_AI_PROVIDER: 'anthropic', LINEUP_AI_API_KEY: 'sk-ant-hidden' } });
    const view = await handleTunarrApi(request('POST', '/api/tunarr/setup/unlock', { code: CODE }), config);
    const text = String(view.body);
    for (const secret of ['s3cret', 'admin', 'sk-ant-hidden']) expect(text).not.toContain(secret);
    expect(json(view)).toMatchObject({ tunarr: { url: 'http://tunarr:8000', credentials: true }, ai: { provider: 'anthropic', keySet: true } });
    // Sending the shown address back keeps the saved one, credentials and all; the key is kept too.
    expect((await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ ai: { provider: 'anthropic', model: '', baseUrl: '' } })), config)).status).toBe(200);
    expect(config.target?.authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);
    expect(config.ai).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-hidden' });
  });
});

describe('server-config (after setup)', () => {
  const ready = async () => {
    const server = await setupServer();
    await handleTunarrApi(request('POST', '/api/tunarr/setup/finish', finishBody({ ai: { provider: 'anthropic', apiKey: 'sk-ant-1' } })), server.config);
    return server;
  };

  it('shows the configuration without keys or passwords', async () => {
    const { config } = await ready();
    const response = await handleTunarrApi(request('GET', '/api/tunarr/server-config'), config);
    expect(response.status).toBe(200);
    expect(String(response.body)).not.toMatch(/sk-ant-1|correct horse|passwordHash|salt/);
    expect(json(response)).toMatchObject({ tunarr: { url: 'http://tunarr:8000' }, account: { username: 'ops' }, ai: { provider: 'anthropic', keySet: true } });
  });

  it('changes Tunarr’s address and AI right away, keeping a key that isn’t sent', async () => {
    const { config } = await ready();
    const saved = await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { tunarrUrl: 'http://192.168.1.20:8000', ai: { provider: 'anthropic', model: 'claude-x' } }), config);
    expect(saved.status).toBe(200);
    expect(config.target?.host).toBe('192.168.1.20:8000');
    expect(config.ai).toMatchObject({ apiKey: 'sk-ant-1', model: 'claude-x' });
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { tunarrUrl: '' }), config)).status).toBe(400);
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { ai: { provider: '' } }), config)).status).toBe(200);
    expect(config.ai).toHaveProperty('off');
  });

  it('keeps the webhook address write-only, re-checks it, and sends a test only once one is saved', async () => {
    const { config, store } = await ready();
    expect((await handleTunarrApi(request('POST', '/api/tunarr/server-config/notify-test', {}), config)).status).toBe(409);
    const refused = await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { notifications: { url: 'http://192.168.1.50:8080/notify' } }), config);
    expect(refused.status).toBe(400);
    expect(json(refused).error.message).toContain('Webhook:');
    const saved = await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { notifications: { url: 'https://hooks.example.com/secret-path?token=abc', events: ['scheduled.skipped', 'batch.partial'], includeNames: false } }), config);
    expect(saved.status).toBe(200);
    expect(json(saved).notifications).toMatchObject({ set: true, host: 'hooks.example.com', events: ['scheduled.skipped', 'batch.partial'], includeNames: false, allowPrivate: false });
    expect(JSON.stringify(json(saved))).not.toContain('secret-path');
    expect(config.notifier?.settings?.url.href).toBe('https://hooks.example.com/secret-path?token=abc');
    expect((await store.read())?.values.LINEUP_NOTIFY_URL).toBe('https://hooks.example.com/secret-path?token=abc');
    // Leaving the address out keeps it; turning the private exception off re-checks it.
    await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { notifications: { url: 'http://192.168.1.50:8080/notify', allowPrivate: true } }), config);
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { notifications: { allowPrivate: false } }), config)).status).toBe(400);
    // Empty turns notifications off.
    await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { notifications: { url: '' } }), config);
    expect(config.notifier?.settings).toBeNull();
  });

  it('changes the sign-in only with the current password', async () => {
    const { config, setup } = await ready();
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { account: { currentPassword: 'wrong', newPassword: 'new password' } }), config)).status).toBe(403);
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { account: { currentPassword: 'correct horse', newPassword: 'tiny' } }), config)).status).toBe(400);
    expect((await handleTunarrApi(request('PUT', '/api/tunarr/server-config', { account: { currentPassword: 'correct horse', username: 'desk', newPassword: 'new password' } }), config)).status).toBe(200);
    const auth = setup.auth();
    expect(await authorize(basic('desk', 'new password'), auth)).toBe(true);
    expect(await authorize(basic('ops', 'correct horse'), auth)).toBe(false);
  });
});

describe('companion HTTP app with setup', () => {
  const servers: Array<{ close(cb: () => void): void }> = [];
  afterAll(async () => { await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(resolve)))); });

  it('serves the wizard to any host name, then asks everyone to sign in', async () => {
    const { config, setup } = await setupServer({}, { appKey: 'desktop-key-0123456789' });
    const root = await tempDir('setup-static');
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Lineup</title>');
    const server = createLineupServer({ config, auth: () => setup.auth(), staticRoot: root });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    // fetch can't set Host, so a page opened as nas.local is sent with http.request.
    const asNas = (headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      http.request({ host: '127.0.0.1', port, path: '/', headers: { host: 'nas.local:3000', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject).end();
    });

    expect(await asNas()).toBe(200);
    expect((await fetch(`${base}/api/tunarr/channels`)).status).toBe(503);
    // Uploads skip the proxy, so they are gated on their own.
    expect((await fetch(`${base}/api/tunarr/media-folder/station-id/a.mp4`, { method: 'PUT', body: 'x', headers: { 'content-type': 'video/mp4' } })).status).toBe(503);
    const finished = await fetch(`${base}/api/tunarr/setup/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(finishBody()) });
    expect(finished.status).toBe(200);

    const unsigned = await fetch(`${base}/`);
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get('www-authenticate')).toMatch(/^Basic/);
    expect((await fetch(`${base}/`, { headers: { authorization: basic('ops', 'correct horse') } })).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { authorization: basic(APP_USER, 'desktop-key-0123456789') } })).status).toBe(200);
    // With sign-in on, any host name works (the browser holds the password for the real address only).
    expect(await asNas({ authorization: basic('ops', 'correct horse') })).toBe(200);
    expect(await asNas()).toBe(401);
  });
});
