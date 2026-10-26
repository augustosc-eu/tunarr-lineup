// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FillerFoldersDialog, MEDIA_COMPOSE_SNIPPET } from '../app/components/FillerFoldersDialog';

const OFF = 'Uploads are off: no media folder is set up. Choose one under Setup → Server Settings.';

/** A companion with uploads off and nothing else set up. */
function companion(url: string) {
  const path = new URL(url, 'http://lineup.test').pathname;
  if (path === '/api/tunarr/media-folder') return { enabled: false, message: OFF };
  if (path === '/api/tunarr/filler-folders/sync') return { connected: false, created: [], updated: [], errors: [] };
  if (path === '/api/tunarr/filler-folders') return { links: {}, pending: {}, ignored: [] };
  return [];
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(companion(url)), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FillerFoldersDialog with uploads off', () => {
  const open = () => render(<FillerFoldersDialog roles={{}} onClose={() => undefined} onChanged={() => undefined} />);

  it('shows the compose lines that turn uploads on, with one shared volume', async () => {
    open();
    const lines = await screen.findByLabelText('docker-compose.yml lines for the upload folder');
    expect(screen.getByText(/Uploads are off/)).toBeTruthy();
    expect(lines.textContent).toBe(MEDIA_COMPOSE_SNIPPET);
    // The folder itself is chosen under Server Settings, not in the environment.
    expect(MEDIA_COMPOSE_SNIPPET).not.toContain('LINEUP_MEDIA_DIR');
    expect(MEDIA_COMPOSE_SNIPPET.match(/- lineup-media:\/media\/lineup/g)).toHaveLength(2);
  });

  it('copies the lines to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy lines' }));
    expect(await screen.findByText(/Copied\. Add these lines/)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(MEDIA_COMPOSE_SNIPPET);
  });

  it('selects the lines when the clipboard is unavailable (plain HTTP on a LAN)', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy lines' }));
    expect(await screen.findByText(/Press Ctrl\+C/)).toBeTruthy();
    expect(window.getSelection()?.toString()).toBe(MEDIA_COMPOSE_SNIPPET);
  });
});

describe('FillerFoldersDialog on a Tunarr that lacks some of pickup', () => {
  const syncs = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith('/filler-folders/sync')).length;

  it('says which steps pickup left out', async () => {
    const skipped = 'The upload folder wasn’t added to Tunarr: This Tunarr’s API doesn’t offer adding media sources (also filler folders).';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = String(url).endsWith('/filler-folders/sync') ? { connected: false, created: [], updated: [], errors: [], skipped: [skipped] } : companion(url);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    render(<FillerFoldersDialog roles={{}} blocked={(id, part) => (id === 'media-sources' && part === 'create' ? 'No adding.' : null)} onClose={() => undefined} onChanged={() => undefined} />);
    expect(await screen.findByText(skipped)).toBeTruthy();
    expect(screen.queryByText('Pickup')).toBeNull();
  });

  it('doesn’t ask for pickup at all, now or every few seconds, when every step of it is refused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const off = new Set(['media-sources/create', 'filler-lists/create', 'filler-lists/edit']);
      render(<FillerFoldersDialog roles={{}} blocked={(id, part) => (off.has(`${id}/${part}`) ? 'Not here.' : null)} onClose={() => undefined} onChanged={() => undefined} />);
      await screen.findByLabelText('docker-compose.yml lines for the upload folder');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(syncs()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
