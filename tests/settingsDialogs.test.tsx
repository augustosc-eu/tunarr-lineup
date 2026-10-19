// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelSettingsDialog } from '../app/components/ChannelSettingsDialog';
import { ServerSettingsDialog } from '../app/components/ServerSettingsDialog';
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
  it('saves a setting, shows where each value comes from, and goes back to .env', async () => {
    const config = createProxyConfig({ LINEUP_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'lineup-settings-ui-')), TUNARR_TIMEOUT_MS: '5000', LINEUP_PASSWORD: 'hunter2' });
    throughCompanion(config);
    render(<ServerSettingsDialog onClose={() => undefined} />);
    const timeout = await screen.findByLabelText('Tunarr request timeout (seconds)');
    expect((timeout as HTMLInputElement).value).toBe('5');
    expect(screen.getAllByText('From .env').length).toBe(1);
    expect(screen.getByLabelText('Settings kept in .env').textContent).toContain('Sign-in passwordSet');
    expect(document.body.textContent).not.toContain('hunter2');

    fireEvent.change(timeout, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText('Settings saved.')).toBeTruthy();
    expect(config.timeoutMs).toBe(20_000);
    expect(screen.getByText('Saved here')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Use the .env value for Tunarr request timeout' }));
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
