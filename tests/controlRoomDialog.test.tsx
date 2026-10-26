// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlRoomDialog } from '../app/components/ControlRoomDialog';

const NOW = Date.now();
const channel = (id: string, number: number, extra: Record<string, unknown> = {}) => ({ id, number, name: `Channel ${number}`, group: '', viewers: 0, streams: 0, now: { start: NOW - 60_000, stop: NOW + 600_000, type: 'content', title: `Show ${number}`, detail: '' }, next: null, guide: 'ok', pendingChanges: 0, nextChangeAt: null, diagnostic: null, ...extra });

function fakeCompanion() {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    requests.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url === '/api/tunarr/control-room') {
      return new Response(JSON.stringify({ at: NOW, guide: { status: 'ok' }, sessions: { status: 'ok' }, scheduler: { enabled: true }, programming: { status: 'ok' }, channels: [channel('c1', 1, { viewers: 2, streams: 1 }), channel('c2', 2, { pendingChanges: 1, nextChangeAt: NOW + 3_600_000 }), channel('c3', 3)] }), { status: 200 });
    }
    if (url === '/api/tunarr/control-room/check') {
      const ids = (JSON.parse(String(init.body)) as { channelIds: string[] }).channelIds;
      return new Response(JSON.stringify({ diagnostics: ids.map((id) => ({ channelId: id, checkedAt: NOW, status: id === 'c2' ? 'error' : 'healthy', mode: 'manual', items: 3, cycleMs: 1, redirects: [], findings: id === 'c2' ? [{ id: 'missing-program', severity: 'error', title: '1 program Tunarr no longer has', detail: 'Position #2.' }] : [] })) }), { status: 200 });
    }
    if (url.endsWith('/stream.m3u8')) return new Response('#EXTM3U\n', { status: 200 });
    return new Response('{}', { status: 404 });
  }));
  return requests;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ControlRoomDialog', () => {
  it('is driven entirely by the remote: move, filter, check, act, step back and close', async () => {
    const requests = fakeCompanion();
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(<ControlRoomDialog now={NOW} activeChannelId="c2" onAction={onAction} onClose={onClose} />);
    const list = await screen.findByRole('list', { name: 'Channels' });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(3));
    // Opens on the desk's channel, and never calls a channel healthy before it's checked.
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 2 Channel 2: Not checked/));
    expect(screen.getByRole('button', { name: 'Watched (1)' })).toBeTruthy();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 3/));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 1/));

    // A checks every channel shown, in one batch.
    fireEvent.keyDown(document.activeElement!, { key: 'a' });
    await waitFor(() => expect(within(list).getByRole('button', { name: /^CH 2 Channel 2: Error/ })).toBeTruthy());
    expect(requests.filter((request) => request.url === '/api/tunarr/control-room/check').map((request) => request.body)).toEqual([{ channelIds: ['c1', 'c2', 'c3'] }]);

    // F cycles the filter: All → Errors.
    fireEvent.keyDown(document.activeElement!, { key: 'f' });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Errors (1)' }).getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 2/));
    expect(screen.getByRole('list', { name: 'Findings' }).textContent).toContain('1 program Tunarr no longer has');

    // OK opens the actions; ↓ moves through them; OK runs one.
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Open in the desk'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Check lineup');
    fireEvent.click(document.activeElement!);
    expect(onAction).toHaveBeenCalledWith('check', 'c2');

    // Back steps out of the actions, then closes.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 2/));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('checks a stream only when asked, reading the playlist alone', async () => {
    const requests = fakeCompanion();
    render(<ControlRoomDialog now={NOW} activeChannelId="c1" onAction={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toMatch(/^CH 1/));
    expect(requests.some((request) => request.url.includes('stream'))).toBe(false);
    fireEvent.keyDown(document.activeElement!, { key: 's' });
    expect(await screen.findByText(/Stream playlist answered/)).toBeTruthy();
    expect(requests.filter((request) => request.url.includes('stream')).map((request) => request.url)).toEqual(['/api/tunarr/channels/c1/stream.m3u8']);
  });
});
