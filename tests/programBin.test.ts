import { describe, expect, it } from 'vitest';
import type { ContentProgram } from '../lib/library';
import { arrangedDuration, arrangePrograms, DEFAULT_BIN_OPTIONS, episodeOrder, MAX_BIN_REPEAT, placedLabel } from '../lib/programBin';
import { libraryArtwork } from '../lib/programInfo';

const MINUTE = 60_000;
const uuid = (n: number) => `0b6f5c4e-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;
const movie = (n: number, title: string, minutes = 90): ContentProgram => ({ type: 'content', id: uuid(n), duration: minutes * MINUTE, program: { uuid: uuid(n), type: 'movie', title } });
const episode = (n: number, show: string, season: number, number: number): ContentProgram => ({
  type: 'content', id: uuid(n), duration: 22 * MINUTE,
  program: { uuid: uuid(n), type: 'episode', title: `${show} ${season}x${number}`, seasonNumber: season, episodeNumber: number, show: { uuid: `show-${show}`, title: show } },
});

describe('program bin', () => {
  it('places programs as picked, with their metadata, and leaves out zero-length ones', () => {
    const empty = { ...movie(3, 'Broken'), duration: 0 };
    const arranged = arrangePrograms([movie(1, 'A'), empty, movie(2, 'B')], DEFAULT_BIN_OPTIONS);
    expect(arranged.items).toEqual([{ type: 'content', id: uuid(1), duration: 90 * MINUTE }, { type: 'content', id: uuid(2), duration: 90 * MINUTE }]);
    expect(Object.keys(arranged.meta)).toEqual([uuid(1), uuid(2)]);
    expect(arrangedDuration(arranged)).toBe(180 * MINUTE);
  });

  it('orders episodes by season and episode, keeping each show where it was first picked', () => {
    const picked = [episode(1, 'Zed', 2, 1), episode(2, 'Abe', 1, 2), movie(9, 'Film'), episode(3, 'Zed', 1, 5), episode(4, 'Abe', 1, 1)];
    expect(episodeOrder(picked).map((program) => program.id)).toEqual([uuid(3), uuid(1), uuid(4), uuid(2), uuid(9)]);
  });

  it('repeats in passes, reshuffling each one', () => {
    const picked = [movie(1, 'A'), movie(2, 'B'), movie(3, 'C')];
    const twice = arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, repeat: 2 });
    expect(twice.items.map((item) => item.id)).toEqual([uuid(1), uuid(2), uuid(3), uuid(1), uuid(2), uuid(3)]);
    const draws = [0, 0, 0.99, 0.99];
    const shuffled = arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, order: 'shuffle', repeat: 2 }, () => draws.shift() ?? 0);
    expect(shuffled.items.map((item) => item.id)).toEqual([uuid(2), uuid(3), uuid(1), uuid(1), uuid(2), uuid(3)]);
    expect(arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, repeat: 999 }).items).toHaveLength(3 * MAX_BIN_REPEAT);
  });

  it('puts flex time or a commercial break after each program, opening breaks with rotating station IDs', () => {
    const picked = [movie(1, 'A', 30), movie(2, 'B', 30), movie(3, 'C', 30)];
    const flex = arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, after: { kind: 'flex', duration: 2 * MINUTE } });
    expect(flex.items.map((item) => item.type)).toEqual(['content', 'flex', 'content', 'flex', 'content', 'flex']);
    const ids = [{ id: uuid(50), duration: 10_000 }, { id: uuid(51), duration: 15_000 }];
    const breaks = arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, after: { kind: 'break', duration: 3 * MINUTE, fillerListIds: ['ads'], stationIds: ids } });
    expect(breaks.items.filter((item) => item.type === 'content').map((item) => item.id)).toEqual([uuid(1), uuid(50), uuid(2), uuid(51), uuid(3), uuid(50)]);
    expect(breaks.items[2]).toMatchObject({ type: 'flex', duration: 3 * MINUTE - 10_000, fillerConfig: { fillerListIds: ['ads'] } });
    // Station IDs aren't titled from the bin's metadata: they keep the desk's own.
    expect(Object.keys(breaks.meta)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect(arrangedDuration(breaks)).toBe(90 * MINUTE + 9 * MINUTE);
    // No lists: no break.
    expect(arrangePrograms(picked, { ...DEFAULT_BIN_OPTIONS, after: { kind: 'break', duration: 3 * MINUTE, fillerListIds: [] } }).items).toHaveLength(3);
  });

  it('labels what was placed for the edit list, counting repeats', () => {
    expect(placedLabel([movie(1, 'A')])).toBe('“A”');
    expect(placedLabel([movie(1, 'A'), movie(2, 'B'), movie(3, 'C'), movie(4, 'D')])).toBe('“A”, “B” and 2 more');
    expect(placedLabel([movie(1, 'A'), movie(1, 'A')])).toBe('“A” (2 airings)');
  });

  it('shows library artwork only through the companion, and only for Tunarr ids', () => {
    expect(libraryArtwork(uuid(1), true)).toBe(`/api/tunarr/programs/${uuid(1)}/artwork/poster`);
    expect(libraryArtwork(uuid(1), true, 'thumbnail')).toBe(`/api/tunarr/programs/${uuid(1)}/artwork/thumbnail`);
    expect(libraryArtwork('../../etc', true)).toBeUndefined();
    expect(libraryArtwork(uuid(1), false)).toBeUndefined();
  });
});
