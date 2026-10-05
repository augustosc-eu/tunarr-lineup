import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateTranscodeChanges } from '../server/admin';
import { createLineupServer } from '../server/app';
import { createAuthConfig } from '../server/auth';
import { createHostPolicy, hostName, isAllowedHost } from '../server/hosts';
import { buildSchedule } from '../server/slotSchedule';
import { filterToRules, rulesToFilter } from '../server/smartCollection';
import { validateTemplate } from '../server/templateSchema';
import { handleTunarrApi, createProxyConfig } from '../server/tunarrProxy';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const role = { id: 'r', label: 'Role' };
const template = (extra: Record<string, unknown> = {}) => ({ id: 'my-test', name: 'Test', roles: [role], days: { all: [['06:00', 'r']] }, ...extra });

describe('host names (DNS rebinding)', () => {
  const none = createHostPolicy({});

  it('answers to IP addresses and localhost by default', () => {
    for (const host of ['127.0.0.1:3000', '192.168.1.20', '[::1]:3000', 'localhost:3000', 'LOCALHOST', 'lineup.localhost', undefined]) {
      expect(isAllowedHost(host, none), String(host)).toBe(true);
    }
    for (const host of ['evil.example:3000', 'evil.example', 'nas.local:3000', '127.0.0.1.evil.example']) {
      expect(isAllowedHost(host, none), host).toBe(false);
    }
  });

  it('adds names from LINEUP_ALLOWED_HOSTS, with ".domain" for subdomains and "*" for any', () => {
    const policy = createHostPolicy({ LINEUP_ALLOWED_HOSTS: ' NAS.local , .home.example ' });
    expect(isAllowedHost('nas.local:3000', policy)).toBe(true);
    expect(isAllowedHost('nas.local.', policy)).toBe(true);
    expect(isAllowedHost('tv.home.example', policy)).toBe(true);
    expect(isAllowedHost('home.example', policy)).toBe(true);
    expect(isAllowedHost('nothome.example', policy)).toBe(false);
    expect(isAllowedHost('evil.example', policy)).toBe(false);
    expect(isAllowedHost('evil.example', createHostPolicy({ LINEUP_ALLOWED_HOSTS: '*' }))).toBe(true);
    expect(hostName('[FE80::1]:3000')).toBe('fe80::1');
  });

  describe('companion server', () => {
    let root: string;
    let dataDir: string;
    const servers: http.Server[] = [];
    const start = async (env: Record<string, string> = {}) => {
      const full = { LINEUP_DATA_DIR: dataDir, ...env };
      const server = createLineupServer({ config: createProxyConfig(full), auth: createAuthConfig(full), staticRoot: root, hosts: createHostPolicy(full) });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      return (server.address() as AddressInfo).port;
    };
    // fetch() won't send a custom Host header, so use http.request.
    const send = (port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers }, (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end(options.body);
      });
    const rebound = { host: 'evil.example:3000', origin: 'http://evil.example:3000', 'content-type': 'application/json' };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), 'lineup-hosts-'));
      dataDir = await mkdtemp(path.join(os.tmpdir(), 'lineup-hosts-data-'));
      await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Lineup</title>');
    });

    afterAll(async () => {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      await rm(root, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    });

    it('refuses a rebound host name, even when Origin matches it', async () => {
      const port = await start();
      const write = await send(port, { method: 'POST', path: '/api/tunarr/templates', headers: rebound, body: JSON.stringify(template()) });
      expect(write.status).toBe(403);
      expect(write.body).toContain('LINEUP_ALLOWED_HOSTS');
      expect((await send(port, { path: '/', headers: { host: 'evil.example:3000' } })).status).toBe(403);
      // Container health checks keep working whatever name they use.
      expect((await send(port, { path: '/healthz', headers: { host: 'evil.example:3000' } })).status).toBe(200);
      expect((await send(port, { path: '/', headers: { host: `127.0.0.1:${port}` } })).status).toBe(200);
    });

    it('answers to names in LINEUP_ALLOWED_HOSTS', async () => {
      const port = await start({ LINEUP_ALLOWED_HOSTS: 'tv.home.example' });
      expect((await send(port, { path: '/', headers: { host: 'tv.home.example:3000' } })).status).toBe(200);
      expect((await send(port, { path: '/', headers: { host: 'evil.example:3000' } })).status).toBe(403);
    });

    it('leaves host names to sign-in when a password is set', async () => {
      const port = await start({ LINEUP_PASSWORD: 'pw' });
      // A rebound page has no credentials for its own name, so it is stopped at sign-in.
      expect((await send(port, { path: '/', headers: { host: 'evil.example:3000' } })).status).toBe(401);
      expect((await send(port, { path: '/', headers: { host: 'nas.local:3000', authorization: basic('lineup', 'pw') } })).status).toBe(200);
    });
  });
});

describe('own keys only', () => {
  it('smart-collection rules refuse inherited names as fields or operators', () => {
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'genre', op: 'toString', values: ['x'] }] })).toHaveProperty('error');
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'year', op: 'constructor', value: 1 }] })).toHaveProperty('error');
    expect(rulesToFilter({ match: 'all', rules: [{ field: 'added_date', op: 'hasOwnProperty', amount: 1, unit: 'day' }] })).toHaveProperty('error');
    for (const field of ['constructor', 'toString', '__proto__']) {
      expect(rulesToFilter({ match: 'all', rules: [{ field, op: 'inthelast', amount: 1, unit: 'day' }] }), field).toHaveProperty('error');
    }
    expect(filterToRules({ type: 'value', fieldSpec: { key: 'genres.name', name: 'genre', op: 'toString', type: 'faceted_string', value: ['x'] } })).toBeNull();
    expect(filterToRules({ type: 'value', fieldSpec: { key: 'duration', name: 'minutes', op: 'valueOf', type: 'numeric', value: 1 } })).toBeNull();
  });

  it('templates refuse inherited ad levels', () => {
    expect(validateTemplate(template({ days: { all: [['06:00', 'r', 'constructor']] } }))).toHaveProperty('error');
    expect(validateTemplate(template({ days: { all: [['06:00', 'r', 'light']] } }))).toHaveProperty('template');
  });

  it('transcode and schedule settings refuse inherited keys', () => {
    expect(validateTranscodeChanges(JSON.parse('{"toString": 1}'))).toHaveProperty('error');
    expect(validateTranscodeChanges(JSON.parse('{"__proto__": {"x": 1}}'))).toHaveProperty('error');
    const slot = { type: 'flex', weight: 1, cooldownMs: 0 };
    expect(buildSchedule(null, { type: 'random', settings: { constructor: 'x' }, slots: [slot] })).toHaveProperty('error');
    expect(buildSchedule(null, { type: 'random', settings: { padStyle: 'episode' }, slots: [slot] })).toHaveProperty('schedule');
  });
});

describe('saved template size', () => {
  it('keeps only rule fields and plain role-default values', () => {
    const checked = validateTemplate(template({
      roles: [{ ...role, suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['episode'], padding: 'x'.repeat(10_000) }] } }],
      defaults: { r: { key: 'show:1', label: 'Show', template: { type: 'show', showId: 'abc', order: 'next', seasonFilter: [1, 2], direction: { nested: 'x'.repeat(10_000) }, recoveryFactor: 'x'.repeat(10_000) } } },
    }));
    if ('error' in checked) throw new Error(checked.error);
    expect(checked.template.roles[0].suggest?.rules).toEqual([{ field: 'type', op: 'is', values: ['episode'] }]);
    expect(checked.template.defaults?.r.template).toEqual({ type: 'show', showId: 'abc', order: 'next', seasonFilter: [1, 2] });
  });
});

describe('without TUNARR_URL', () => {
  it('still saves and lists templates, but the AI and Tunarr routes say Tunarr is not set', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lineup-no-tunarr-'));
    try {
      const config = createProxyConfig({ LINEUP_DATA_DIR: dataDir, LINEUP_AI_PROVIDER: 'openai', LINEUP_AI_BASE_URL: 'http://127.0.0.1:9/v1', LINEUP_AI_MODEL: 'm' });
      const post = (url: string, body: unknown) => handleTunarrApi({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, config);
      expect((await post('/api/tunarr/templates', template())).status).toBe(201);
      const listed = await handleTunarrApi({ method: 'GET', url: '/api/tunarr/templates', headers: {} }, config);
      expect(JSON.parse(listed.body as string)).toHaveLength(1);
      expect((await handleTunarrApi({ method: 'GET', url: '/api/tunarr/ai', headers: {} }, config)).status).toBe(200);
      const ai = await post('/api/tunarr/ai/template', { prompt: 'news channel' });
      expect(ai.status).toBe(503);
      expect(JSON.parse(ai.body as string).error.code).toBe('not_configured');
      expect((await handleTunarrApi({ method: 'GET', url: '/api/tunarr/filler-lists', headers: {} }, config)).status).toBe(503);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
