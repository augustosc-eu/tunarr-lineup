// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BatchDialog } from '../app/components/BatchDialog';
import type { Channel } from '../lib/lineup';
import { createProxyConfig, handleTunarrApi, type ProxyConfig } from '../server/tunarrProxy';

const P1 = '0b6f5c4e-1a2b-4c3d-8e9f-000000000001';
const GONE = '0b6f5c4e-1a2b-4c3d-8e9f-000000000099';
const MIN = 60_000;

/** A stateful Tunarr behind the real companion routes. */
async function companion() {
  const state = {
    channels: [1, 2, 3].map((n) => ({ id: `c${n}`, number: n, name: `Channel ${n}`, groupTitle: 'tunarr', startTime: 0, fillerCollections: [], stealth: false })),
    lineups: Object.fromEntries([1, 2, 3].map((n) => [`c${n}`, [{ type: 'content', id: P1, duration: 30 * MIN }, { type: 'content', id: GONE, duration: 20 * MIN }]])) as Record<string, unknown[]>,
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname === '/api/channels') return json(state.channels);
    if (url.pathname === '/api/filler-lists') return json([]);
    const doc = /^\/api\/channels\/([^/]+)$/.exec(url.pathname);
    if (doc) {
      const channel = state.channels.find((item) => item.id === doc[1])!;
      if (init.method === 'PUT') Object.assign(channel, body);
      return json(channel);
    }
    const programming = /^\/api\/channels\/([^/]+)\/programming$/.exec(url.pathname);
    if (programming) {
      if (init.method === 'POST') state.lineups[programming[1]] = body.lineup;
      return json({ lineup: state.lineups[programming[1]], programs: { [P1]: { title: 'Kept' } } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  const config: ProxyConfig = { ...createProxyConfig({ LINEUP_DATA_DIR: await mkdtemp(path.join(tmpdir(), 'lineup-batch-ui-')), TUNARR_URL: 'http://tunarr:8000' }), fetchImpl };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const response = await handleTunarrApi({ method: init.method ?? 'GET', url, headers: { host: 'lineup.test', 'content-type': 'application/json' }, body: init.body as string | undefined }, config);
    return new Response(response.body as string, { status: response.status, headers: response.headers });
  }));
  return state;
}

const channels = [1, 2, 3].map((n) => ({ id: `c${n}`, number: n, name: `Channel ${n}`, groupTitle: 'tunarr', startTime: 0, duration: 0, programCount: 2 })) as Channel[];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BatchDialog', () => {
  it('previews a group change per channel, applies it, reports it and rolls one channel back', async () => {
    const state = await companion();
    const onDone = vi.fn();
    render(<BatchDialog channels={channels} activeChannelId="c1" initialTask="group" drafts={{}} onDone={onDone} onClose={() => undefined} />);
    // OK (Enter) ticks a checkbox, as on a remote.
    const second = screen.getByRole('checkbox', { name: /Channel 2/ });
    second.focus();
    fireEvent.keyDown(second, { key: 'Enter' });
    expect((second as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Group title'), { target: { value: 'News' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const rows = await screen.findByRole('list', { name: 'Changes per channel' });
    expect(within(rows).getAllByText('Group: “tunarr” → “News”')).toHaveLength(2);
    expect(state.channels.every((channel) => channel.groupTitle === 'tunarr')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 channels…' }));
    expect(screen.getByText('Save 2 channels in Tunarr?')).toBeTruthy();
    // Back steps out of the confirmation, not out of the dialog.
    fireEvent.keyDown(screen.getByRole('button', { name: 'Apply to 2 channels' }), { key: 'Escape' });
    expect(screen.queryByText('Save 2 channels in Tunarr?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 channels…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 2 channels' }));

    const report = await screen.findByRole('list', { name: 'Result per channel' });
    await waitFor(() => expect(within(report).getAllByText('Saved')).toHaveLength(2), { timeout: 4000 });
    expect(state.channels.map((channel) => channel.groupTitle)).toEqual(['News', 'News', 'tunarr']);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.stringContaining('2 saved'), ['c1', 'c2']));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Roll back CH 2 Channel 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Roll back 1 channel' }));
    await waitFor(() => expect(within(report).getByText('Rollback: Back to how it was.')).toBeTruthy(), { timeout: 4000 });
    expect(state.channels.map((channel) => channel.groupTitle)).toEqual(['News', 'tunarr', 'tunarr']);
  });

  it('repairs missing media only after the preview shows the chosen fix', async () => {
    const state = await companion();
    render(<BatchDialog channels={channels} activeChannelId="c1" initialTask="repair" drafts={{}} onDone={() => undefined} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    const choice = await screen.findByRole('combobox', { name: `What to do with the missing program ${GONE}` });
    expect(screen.getByText(/A program Tunarr no longer has \(20 min\)/)).toBeTruthy();
    // Nothing chosen yet: nothing would change.
    expect((screen.getByRole('button', { name: 'Apply to 0 channels…' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(choice, { target: { value: 'flex' } });
    expect(screen.getByText('Your choices changed: update the preview before applying.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Update preview with these choices' }));
    await screen.findByText(/1 turned into flex/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 channel…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 channel' }));
    const report = await screen.findByRole('list', { name: 'Result per channel' });
    await waitFor(() => expect(within(report).getByText('Saved')).toBeTruthy(), { timeout: 4000 });
    expect(state.lineups.c1).toEqual([{ type: 'content', id: P1, duration: 30 * MIN }, { type: 'flex', duration: 20 * MIN }]);
    expect(state.lineups.c2).toHaveLength(2);
  });

  it('closes with Back from the first step', async () => {
    await companion();
    const onClose = vi.fn();
    render(<BatchDialog channels={channels} activeChannelId="c1" initialTask="settings" drafts={{}} onDone={() => undefined} onClose={onClose} />);
    const first = screen.getAllByRole('radio')[0];
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getAllByRole('radio')[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
