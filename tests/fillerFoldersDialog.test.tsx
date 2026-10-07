// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FillerFoldersDialog, MEDIA_COMPOSE_SNIPPET } from '../app/components/FillerFoldersDialog';

const OFF = 'Uploads are off: LINEUP_MEDIA_DIR is not set on the Lineup server.';

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
    expect(MEDIA_COMPOSE_SNIPPET).toContain('LINEUP_MEDIA_DIR=/media/lineup');
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
