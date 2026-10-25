// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerSettingsDialog } from '../app/components/ServerSettingsDialog';
import { SetupWizard } from '../app/components/SetupWizard';
import { configEnv, createConfigStore, type StoredConfig } from '../server/configStore';
import { createSetup } from '../server/setup';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';

const CODE = 'ABCDE-FGHJK';

/** Tunarr answers only at tunarr:8000, as in Docker Compose. */
const fakeTunarr = (async (url: string) => {
  const parsed = new URL(url);
  if (parsed.host !== 'tunarr:8000') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  return new Response(JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), { status: 200, headers: { 'content-type': 'application/json' } });
}) as unknown as typeof fetch;

async function companion(stored: Partial<StoredConfig> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'lineup-wizard-'));
  const initial: StoredConfig = { version: 1, setupComplete: false, values: {}, ...stored };
  const setup = createSetup({ store: createConfigStore(dir), stored: initial, processEnv: { LINEUP_DATA_DIR: dir }, dataDir: dir, code: CODE });
  const config = createProxyConfig(configEnv({ LINEUP_DATA_DIR: dir }, initial.values));
  config.setup = setup;
  config.fetchImpl = fakeTunarr;
  return config;
}

/** Sends the component's requests through the real companion routes. */
function throughCompanion(config: ProxyConfig) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const response = await handleTunarrApi({ method: init.method ?? 'GET', url, headers: { host: 'lineup.test', 'content-type': 'application/json' }, body: init.body as string | undefined }, config);
    return new Response(response.body as string, { status: response.status, headers: response.headers });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('SetupWizard', () => {
  it('walks from the setup code to a signed-in server, finding Tunarr by itself', async () => {
    const config = await companion();
    throughCompanion(config);
    render(<SetupWizard onDemo={() => undefined} />);

    fireEvent.change(screen.getByLabelText('Setup code'), { target: { value: 'WRONG-CODE1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn’t the setup code/);

    fireEvent.change(screen.getByLabelText('Setup code'), { target: { value: CODE.toLowerCase() } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // Found in Docker Compose's usual place, picked and tested.
    expect(await screen.findByText(/Tunarr answered with 3 channels/)).toBeTruthy();
    expect((screen.getByLabelText('Tunarr address') as HTMLInputElement).value).toBe('http://tunarr:8000');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse' } });
    fireEvent.change(screen.getByLabelText('Password again'), { target: { value: 'correct hors' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert').textContent).toMatch(/don’t match/);
    fireEvent.change(screen.getByLabelText('Password again'), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    fireEvent.change(screen.getByLabelText('AI provider'), { target: { value: 'anthropic' } });
    fireEvent.change(screen.getByLabelText('AI API key'), { target: { value: 'sk-ant-wizard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('http://tunarr:8000 · 3 channels')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    expect(await screen.findByText('Lineup is set up')).toBeTruthy();
    expect(config.setup?.needed()).toBe(false);
    expect(config.setup?.auth()?.username).toBe('lineup');
    expect(config.ai).toMatchObject({ provider: 'anthropic', apiKey: 'sk-ant-wizard' });
  });

  it('takes the desktop app’s code from the address and drops it from there', async () => {
    const config = await companion({ values: { TUNARR_URL: 'http://tunarr:8000' } });
    throughCompanion(config);
    window.location.hash = `#setup=${CODE}`;
    render(<SetupWizard onDemo={() => undefined} />);
    expect(await screen.findByText(/came from the server’s old settings/)).toBeTruthy();
    expect(window.location.hash).toBe('');
    // An address that answers wrong needs a test or “use it anyway”.
    fireEvent.change(screen.getByLabelText('Tunarr address'), { target: { value: 'http://nowhere:8000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Could not reach Tunarr at nowhere:8000/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Use it anyway/));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByLabelText('User name')).toBeTruthy();
  });
});

describe('ServerSettingsDialog connection', () => {
  it('changes Tunarr’s address and keeps the AI key it never shows', async () => {
    const config = await companion();
    throughCompanion(config);
    await handleTunarrApi({ method: 'POST', url: '/api/tunarr/setup/finish', headers: { host: 'lineup.test', 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE, tunarrUrl: 'http://192.168.1.9:8000', account: { username: 'ops', password: 'correct horse' }, ai: { provider: 'anthropic', apiKey: 'sk-ant-kept' } }) }, config);
    render(<ServerSettingsDialog onClose={() => undefined} />);
    const address = await screen.findByLabelText('Tunarr address') as HTMLInputElement;
    expect(address.value).toBe('http://192.168.1.9:8000');
    expect(document.body.textContent).not.toContain('sk-ant-kept');
    expect((screen.getByLabelText('AI API key') as HTMLInputElement).placeholder).toMatch(/Saved/);

    fireEvent.change(address, { target: { value: 'http://tunarr:8000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection settings' }));
    expect(await screen.findByText(/Connection settings saved/)).toBeTruthy();
    expect(config.target?.host).toBe('tunarr:8000');
    expect(config.ai).toMatchObject({ apiKey: 'sk-ant-kept' });

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'wrong password' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'new password' } });
    fireEvent.change(screen.getByLabelText('New password again'), { target: { value: 'new password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change sign-in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/isn’t the current password/));
  });
});
