// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalVideosDialog } from '../app/components/LocalVideosDialog';
import type { LocalVideoFolderView } from '../lib/tunarrClient';

const SOURCE = 'fb9b2110-d086-49b3-997c-000000000001';
const LIBRARY = '0e2d2a41-5f2f-4a7e-9d3a-000000000002';
const SHOW = '5e5e5e5e-1a2b-4c3d-8e9f-000000000003';

/** A companion with one uploaded music-video folder (scanned, not followed) and one server folder of videos. */
function companion() {
  const folders: LocalVideoFolderView[] = [
    { key: 'upload:music-videos/Hits', kind: 'music-videos', name: 'Hits', upload: { area: 'music-videos', folder: 'Hits', files: [{ name: 'Abba - SOS.mp4', size: 2_000_000, modifiedAt: 1 }] }, tunarr: { mediaSourceId: SOURCE, libraryId: LIBRARY, source: 'Music videos – Hits', enabled: true, lastScannedAt: 1_000, scanning: false }, show: null, pending: false },
    { key: 'library:x', kind: 'videos', name: 'Concerts', tunarr: null, show: null, pending: true },
  ];
  const shows: Array<{ id: string; name: string; contentCount: number; synced: boolean }> = [];
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const reply = (path: string, method: string, body: Record<string, unknown> | undefined) => {
    if (path === '/api/tunarr/local-videos') return { media: { enabled: true, maxBytes: 4096 * 1024 ** 2 }, folders };
    if (path === '/api/tunarr/local-videos/sync') return { connected: [], created: [], updated: [], errors: [], skipped: [] };
    if (path === '/api/tunarr/custom-shows') return shows;
    if (path === '/api/tunarr/local-videos/folders') {
      folders.push({ key: `upload:${body!.kind}/${body!.name}`, kind: body!.kind as never, name: String(body!.name), upload: { area: body!.kind as never, folder: String(body!.name), files: [] }, tunarr: null, show: null, pending: false });
      return { kind: body!.kind, folder: body!.name };
    }
    if (path === `/api/tunarr/local-videos/libraries/${LIBRARY}` && method === 'PUT') {
      shows.push({ id: SHOW, name: 'Music videos – Hits', contentCount: 1, synced: false });
      folders[0] = { ...folders[0], show: { id: SHOW, builtAt: 2 } };
      return { kind: 'music-videos', pending: false, show: { id: SHOW, count: 1 } };
    }
    return {};
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://lineup.test').pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, method, body });
    return new Response(JSON.stringify(reply(path, method, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  return { requests };
}

let fake: ReturnType<typeof companion>;
beforeEach(() => { fake = companion(); });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('LocalVideosDialog', () => {
  const open = () => render(<LocalVideosDialog onClose={() => undefined} onChanged={() => undefined} />);

  it('lists music-video and video folders with what follows them', async () => {
    open();
    const hits = (await screen.findByText('Hits')).closest('.source-block') as HTMLElement;
    expect(within(hits).getByText(/Lineup media folder · 1 video · scanned/)).toBeTruthy();
    expect(within(hits).getByRole('button', { name: 'Upload videos…' })).toBeTruthy();
    const concerts = screen.getByText('Concerts').closest('.source-block') as HTMLElement;
    expect(within(concerts).getByText('→ a custom show after its scan')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['Music videos', 'Videos', 'New folder in Lineup’s media folder', 'Add a folder on the Tunarr server']);
  });

  it('keeps a custom show of a folder and names it', async () => {
    const changed = vi.fn();
    render(<LocalVideosDialog onClose={() => undefined} onChanged={changed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep a custom show' }));
    expect(await screen.findByText(/Made a custom show of “Hits” with 1 video/)).toBeTruthy();
    expect(fake.requests.find((entry) => entry.method === 'PUT')).toMatchObject({ path: `/api/tunarr/local-videos/libraries/${LIBRARY}`, body: { follow: true } });
    expect(changed).toHaveBeenCalled();
    expect(await screen.findByText('→ “Music videos – Hits” (1 video)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeTruthy();
  });

  it('makes a new folder to upload into', async () => {
    open();
    fireEvent.change(await screen.findByLabelText('New folder holds'), { target: { value: 'videos' } });
    fireEvent.change(screen.getByLabelText('New folder name'), { target: { value: 'Web series' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make folder' }));
    expect(await screen.findByText(/Made the folder “Web series” in Videos/)).toBeTruthy();
    expect(fake.requests.find((entry) => entry.path === '/api/tunarr/local-videos/folders')?.body).toEqual({ kind: 'videos', name: 'Web series', follow: true });
    await waitFor(() => expect(screen.getByText('Web series')).toBeTruthy());
  });

  it('moves between controls with the D-pad', async () => {
    open();
    const first = await screen.findByLabelText('What Hits holds');
    const scan = screen.getAllByRole('button', { name: 'Scan now' })[0];
    scan.focus();
    fireEvent.keyDown(scan, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
  });
});
