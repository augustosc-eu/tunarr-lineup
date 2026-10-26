// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelSettingsDialog } from '../app/components/ChannelSettingsDialog';
import { ServerSettingsDialog } from '../app/components/ServerSettingsDialog';
import { CompatibilityPanel } from '../app/components/CompatibilityPanel';
import { ListsManager } from '../app/components/ListsManager';
import { MediaSourcesDialog } from '../app/components/MediaSourcesDialog';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';

const ID1 = 'b0000000-0000-4000-8000-000000000001';
const ID2 = 'b0000000-0000-4000-8000-000000000002';

/** Sends the dialog's requests through the real companion routes. */
function throughCompanion(config: ProxyConfig) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const response = await handleTunarrApi({ method: init.method ?? 'GET', url, headers: { host: 'lineup.test', 'content-type': 'application/json' }, body: init.body as string | undefined }, config);
    return new Response(response.body as string, { status: response.status, headers: response.headers });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ServerSettingsDialog', () => {
  it('saves a setting, shows where each value comes from, and resets it', async () => {
    const config = createProxyConfig({ LINEUP_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'lineup-settings-ui-')), TUNARR_TIMEOUT_MS: '5000', LINEUP_PASSWORD: 'hunter2' });
    throughCompanion(config);
    render(<ServerSettingsDialog onClose={() => undefined} />);
    const timeout = await screen.findByLabelText('Tunarr request timeout (seconds)');
    expect((timeout as HTMLInputElement).value).toBe('5');
    expect(screen.getAllByText('From setup').length).toBe(1);
    expect(screen.getByLabelText('Settings set where the server starts').textContent).toContain('Data folderSet');
    // Configured only where it runs (no config.json): no connection section.
    expect(screen.queryByLabelText('Tunarr address')).toBeNull();
    expect(document.body.textContent).not.toContain('hunter2');

    fireEvent.change(timeout, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    expect(config.timeoutMs).toBe(20_000);
    expect(screen.getByText('Saved here')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reset Tunarr request timeout' }));
    await waitFor(() => expect(config.timeoutMs).toBe(5000));
    expect(((await screen.findByLabelText('Tunarr request timeout (seconds)')) as HTMLInputElement).value).toBe('5');
  });
});

describe('ChannelSettingsDialog station IDs', () => {
  it('picks single station IDs without saving anything to Tunarr', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url });
      const body = url.endsWith('/settings') ? { id: 'chan-1', name: 'One', number: 1, fillerCollections: [] } : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const onSaveStationIds = vi.fn(async () => undefined);
    const onSaved = vi.fn();
    render(<ChannelSettingsDialog
      channelId="chan-1"
      stationIdChoices={[{ id: ID1, title: 'One ID', duration: 10_000 }, { id: ID2, title: 'Two ID', duration: 15_000, note: 'named for Two' }]}
      pickedStationIds={[ID2]}
      onSaveStationIds={onSaveStationIds}
      onClose={() => undefined}
      onSaved={onSaved}
    />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Commercials' }));
    const group = screen.getByRole('group', { name: 'Station IDs picked for this channel' });
    expect(group.textContent).toContain('named for Two');
    const save = screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /One ID/ }));
    fireEvent.click(save);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaveStationIds).toHaveBeenCalledWith([ID2, ID1]);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('Server Settings → Compatibility', () => {
  const report = (status: 'available' | 'unavailable') => ({
    checkedAt: Date.UTC(2026, 9, 25, 12), configured: true, connected: true, apiDescription: 'read',
    version: { tunarr: '0.9.0', source: 'api', status: 'unvalidated', note: 'Lineup is built for Tunarr 1.x; this version hasn’t been validated.' },
    capabilities: [
      { id: 'connection', label: 'Connection', uses: 'Everything', status: 'available', reason: 'Checked with a read-only request.' },
      { id: 'sessions', label: 'Viewer counts', uses: 'Viewer badges', status, reason: status === 'available' ? 'Checked with a read-only request.' : 'This Tunarr doesn’t have the route Lineup uses for it.' },
    ],
  });

  it('shows the version warning, what is turned off, checks again and exports diagnostics', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let refreshed = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ method: init.method ?? 'GET', url });
      if (url.endsWith('/compatibility/refresh')) refreshed = true;
      const body = url.includes('/compatibility') ? report(refreshed ? 'available' : 'unavailable') : url.endsWith('/server-config') ? { error: { code: 'setup_off', message: 'x' } } : { editable: [], fixed: [], restartNote: '' };
      return new Response(JSON.stringify(body), { status: url.endsWith('/server-config') ? 503 : 200, headers: { 'content-type': 'application/json' } });
    }));
    let exported: Blob | undefined;
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: (blob: Blob) => { exported = blob; return 'blob:diagnostics'; } });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const onCompatibility = vi.fn();
    render(<ServerSettingsDialog onClose={() => undefined} onCompatibility={onCompatibility} />);
    expect(await screen.findByText('Tunarr 0.9.0 (not validated)')).toBeTruthy();
    expect(screen.getByText('Version not validated')).toBeTruthy();
    expect(screen.getByText('Turned off in the desk')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Viewer counts: Not available/ })).toBeTruthy();
    expect(onCompatibility).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('button', { name: /Viewer counts: Available/ })).toBeTruthy();
    expect(screen.queryByText('Turned off in the desk')).toBeNull();
    expect(calls.some((call) => call.method === 'POST' && call.url === '/api/tunarr/compatibility/refresh')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    expect(click).toHaveBeenCalledOnce();
    click.mockRestore();
    const file = JSON.parse(await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(exported!);
    }));
    expect(file).toMatchObject({ format: 'tunarr-lineup-diagnostics', tunarrVersion: { tunarr: '0.9.0' } });
  });
});

describe('actions this Tunarr doesn’t offer', () => {
  const LIST = '5e5e5e5e-1a2b-4c3d-8e9f-00000000000a';
  const stub = (routes: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://lineup.test').pathname;
    return new Response(JSON.stringify(routes[path] ?? []), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  const reason = 'This Tunarr’s API doesn’t offer deleting filler lists, so it’s turned off here.';

  it('turns off a list manager’s delete and says why, keeping the rest', async () => {
    stub({ '/api/tunarr/filler-lists': [{ id: LIST, name: 'Ads', contentCount: 0 }] });
    render(<ListsManager kind="filler" blocked={(id, part) => (id === 'filler-lists' && part === 'delete' ? reason : null)} onClose={() => undefined} />);
    expect((await screen.findByRole('note')).textContent).toContain(reason);
    fireEvent.click(await screen.findByRole('option', { name: /Ads/ }));
    expect((await screen.findByRole('button', { name: 'Delete…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'New filler list' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('turns off removing and scanning media sources, and signing in to Jellyfin', async () => {
    const source = { id: 'src1', name: 'Plex', type: 'plex', libraries: [{ id: 'lib1', name: 'Movies', enabled: true }] };
    stub({ '/api/tunarr/media-sources/manage': [source] });
    const off = new Set(['delete', 'scan', 'sign-in-jellyfin']);
    render(<MediaSourcesDialog blocked={(id, part) => (id === 'media-sources' && off.has(part) ? `No ${part}.` : null)} onClose={() => undefined} />);
    expect((await screen.findByRole('button', { name: 'Remove…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Scan now' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Refresh libraries' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('note').textContent).toContain('No delete.');
    fireEvent.click(screen.getByRole('button', { name: 'Add media source…' }));
    fireEvent.change(screen.getByLabelText('Source type'), { target: { value: 'jellyfin' } });
    expect(screen.getAllByRole('note').some((note) => note.textContent?.includes('No sign-in-jellyfin.'))).toBe(true);
  });

  it('lists what is partly turned off in Server Settings → Compatibility', async () => {
    const partly = {
      checkedAt: Date.UTC(2026, 9, 25, 12), configured: true, connected: true, apiDescription: 'read',
      version: { tunarr: '1.3.13', source: 'api', status: 'validated', note: '' },
      capabilities: [{ id: 'filler-lists', label: 'Filler lists', uses: 'Commercials', status: 'degraded', reason: 'Checked with a read-only request.', parts: [{ id: 'delete', label: 'deleting filler lists', status: 'unavailable' }, { id: 'create', label: 'creating filler lists', status: 'available' }] }],
    };
    stub({ '/api/tunarr/compatibility': partly });
    render(<CompatibilityPanel />);
    expect(await screen.findByText('Partly turned off')).toBeTruthy();
    expect(screen.getByText(/Filler lists: deleting filler lists\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Filler lists: Limited/ })).toBeTruthy();
  });
});
