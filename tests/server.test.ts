import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLineupServer } from '../server/app';
import { createAuthConfig, isAuthorized } from '../server/auth';
import { createProxyConfig } from '../server/tunarrProxy';

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('optional sign-in', () => {
  it('is off unless LINEUP_PASSWORD is set', () => {
    expect(createAuthConfig({})).toBeNull();
    expect(isAuthorized(undefined, null)).toBe(true);
  });

  it('checks Basic credentials', () => {
    const auth = createAuthConfig({ LINEUP_PASSWORD: 'c0rrect horse' })!;
    expect(auth.username).toBe('lineup');
    expect(isAuthorized(basic('lineup', 'c0rrect horse'), auth)).toBe(true);
    expect(isAuthorized(basic('lineup', 'wrong'), auth)).toBe(false);
    expect(isAuthorized(basic('admin', 'c0rrect horse'), auth)).toBe(false);
    expect(isAuthorized('Bearer abc', auth)).toBe(false);
    expect(isAuthorized(undefined, auth)).toBe(false);
    expect(isAuthorized(basic('ops', 'pw:with:colons'), createAuthConfig({ LINEUP_PASSWORD: 'pw:with:colons', LINEUP_USERNAME: 'ops' }))).toBe(true);
  });
});

describe('companion HTTP app', () => {
  let root: string;
  const servers: http.Server[] = [];
  const start = async (env: Record<string, string> = {}) => {
    const server = createLineupServer({ config: createProxyConfig(env), auth: createAuthConfig(env), staticRoot: root });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'lineup-static-'));
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Lineup</title>');
    await writeFile(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(path.join(os.tmpdir(), 'lineup-secret.txt'), 'secret');
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(root, { recursive: true, force: true });
  });

  it('serves the interface with a same-origin CSP and SPA fallback', async () => {
    const base = await start();
    const index = await fetch(`${base}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(await (await fetch(`${base}/some/deep/link`)).text()).toContain('<title>Lineup</title>');
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/missing.js`)).status).toBe(404);
  });

  it('never serves files outside the static root', async () => {
    const base = await start();
    for (const attempt of ['/..%2flineup-secret.txt', '/%2e%2e/lineup-secret.txt', '/assets/..%2f..%2flineup-secret.txt']) {
      const response = await fetch(`${base}${attempt}`);
      expect(await response.text()).not.toContain('secret');
    }
  });

  it('requires sign-in for everything except /healthz when a password is set', async () => {
    const base = await start({ LINEUP_PASSWORD: 'pw' });
    const blocked = await fetch(`${base}/`);
    expect(blocked.status).toBe(401);
    expect(blocked.headers.get('www-authenticate')).toContain('Basic');
    expect((await fetch(`${base}/api/tunarr/health`)).status).toBe(401);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/`, { headers: { authorization: basic('lineup', 'pw') } })).status).toBe(200);
    const api = await fetch(`${base}/api/tunarr/health`, { headers: { authorization: basic('lineup', 'pw') } });
    expect(api.status).toBe(503);
    expect(((await api.json()) as { status: string }).status).toBe('not_configured');
  });

  it('rejects writes to static paths', async () => {
    const base = await start();
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });
});
