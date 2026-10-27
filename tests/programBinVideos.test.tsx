// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramBin } from '../app/components/ProgramBin';
import type { Arranged } from '../lib/programBin';

const id = (n: number) => `4d4d4d4d-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;
const TITLES = ['Abba - Waterloo (Official Video) [abcDEF12345]', 'Blur - Song 2', 'Abba - SOS', 'Cher - Believe', 'Clip without artist'];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url, 'http://lineup.test').pathname;
    const body = path === '/api/tunarr/media-sources'
      ? [{ id: id(90), name: 'Music videos – Hits', type: 'local', libraries: [{ id: id(91), name: 'Hits', mediaType: 'other_videos' }] }]
      : path === '/api/tunarr/library/search'
        ? { results: TITLES.map((title, at) => ({ uuid: id(at + 1), type: 'other_video', title, duration: 240_000 })), page: 0, totalPages: 1, totalHits: TITLES.length }
        : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function bin(onPlace: (arranged: Arranged) => boolean) {
  return render(<ProgramBin live anchorLabel="the selection" emptyLineup={false} date="2026-10-27" time="20:00" commercialLists={[]} stationIds={[]}
    startFor={() => ({ start: 0, passes: 0, gap: 0, moved: false })} onPlace={(arranged) => onPlace(arranged)} planSlots={() => null} onPlaceSlots={() => false}
    now={0} scheduleType="manual" onScheduleShows={async () => false} onChooseSpot={() => undefined} onDragPrograms={() => undefined} onDragEnd={() => undefined} onClose={() => undefined} />);
}

describe('music videos in the program bin', () => {
  it('shows clean titles, groups by artist and picks a whole artist', async () => {
    bin(() => true);
    expect(await screen.findByRole('button', { name: 'Pick Abba – Waterloo' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Group by artist' }));
    const abba = screen.getByRole('region', { name: 'Abba' });
    expect(within(abba).getByText('2 videos')).toBeTruthy();
    // Under its artist, a card shows the song alone.
    expect(within(abba).getByRole('button', { name: 'Pick Waterloo' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'No artist in the file name' })).toBeTruthy();
    fireEvent.click(within(abba).getByRole('button', { name: 'Pick all of Abba' }));
    expect(within(screen.getByRole('list')).getByText(/Abba · 2 programs/)).toBeTruthy();
  });

  it('fills an hour with artists apart and places it', async () => {
    const onPlace = vi.fn(() => true);
    bin(onPlace);
    fireEvent.click(await screen.findByRole('button', { name: 'Pick all shown' }));
    fireEvent.change(screen.getByLabelText('Play order'), { target: { value: 'spread' } });
    fireEvent.change(screen.getByLabelText('Length'), { target: { value: 'fill' } });
    expect(screen.getByText(/filling 60 min \(15 airings\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Place 5 on schedule/ }));
    const arranged = (onPlace.mock.calls[0] as unknown as [Arranged])[0];
    expect(arranged.programs).toHaveLength(15);
    const titles = arranged.programs.map((program) => String((program.program as { title: string }).title).split(' - ')[0]);
    for (let at = 1; at < titles.length; at += 1) expect(titles[at]).not.toBe(titles[at - 1]);
  });
});
