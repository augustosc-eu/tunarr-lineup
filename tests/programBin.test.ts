import { describe, expect, it } from 'vitest';
import { exactBoundary } from '../lib/events';
import type { ContentProgram } from '../lib/library';
import type { LineupItem } from '../lib/lineup';
import { arrangedDuration, arrangePrograms, DEFAULT_BIN_OPTIONS, episodeOrder, MAX_BIN_REPEAT, mixedInOrder, placedLabel, placeInSlots, slotTimes, slotWindow } from '../lib/programBin';
import { keptStartTime } from '../server/lineupVersion';
import { libraryArtwork } from '../lib/programInfo';

const MINUTE = 60_000;
const uuid = (n: number) => `0b6f5c4e-1a2b-4c3d-8e9f-${String(n).padStart(12, '0')}`;
const movie = (n: number, title: string, minutes = 90): ContentProgram => ({ type: 'content', id: uuid(n), duration: minutes * MINUTE, program: { uuid: uuid(n), type: 'movie', title } });
const episode = (n: number, show: string, season: number, number: number): ContentProgram => ({
  type: 'content', id: uuid(n), duration: 22 * MINUTE,
  program: { uuid: uuid(n), type: 'episode', title: `${show} ${season}x${number}`, seasonNumber: season, episodeNumber: number, show: { uuid: `show-${show}`, title: show } },
});

const HOUR = 60 * MINUTE;
const filler = (count: number, minutes = 60): LineupItem[] => Array.from({ length: count }, (_, at) => ({ type: 'content', id: `old-${at}`, duration: minutes * MINUTE }));
const sum = (items: LineupItem[]) => items.reduce((total, item) => total + item.duration, 0);
/** When lineup[index] airs on the pass around `near`. */
const airs = (lineup: LineupItem[], start: number, index: number, near: number) => start + Math.floor((near - start) / sum(lineup)) * sum(lineup) + sum(lineup.slice(0, index));
const MONDAY = new Date(2026, 9, 19).getTime();

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

  it('mixes shows at random while each show keeps its season and episode order', () => {
    // Picked out of order, the way a show's seasons might be picked last first.
    const picked = [episode(1, 'Zed', 2, 1), episode(2, 'Zed', 1, 2), episode(3, 'Zed', 1, 1), episode(4, 'Abe', 1, 2), episode(5, 'Abe', 1, 1), movie(9, 'Film')];
    const inShow = (order: ContentProgram[], show: string) => order.filter((program) => (program.program as { show?: { title?: string } }).show?.title === show).map((program) => program.id);
    let seed = 7;
    const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const orders = Array.from({ length: 20 }, () => mixedInOrder(picked, random));
    for (const order of orders) {
      expect(order).toHaveLength(picked.length);
      expect(inShow(order, 'Zed')).toEqual([uuid(3), uuid(2), uuid(1)]);
      expect(inShow(order, 'Abe')).toEqual([uuid(5), uuid(4)]);
    }
    // The shows really are mixed: not always the same order.
    expect(new Set(orders.map((order) => order.map((program) => program.id).join())).size).toBeGreaterThan(1);
    // Draws at the very top of the range still land on a show with episodes left.
    expect(mixedInOrder(picked, () => 0.999999)).toHaveLength(picked.length);
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

  it('arranges each program with what airs after it as one unit, for time slots', () => {
    const arranged = arrangePrograms([movie(1, 'A', 30), movie(2, 'B', 30)], { ...DEFAULT_BIN_OPTIONS, after: { kind: 'flex', duration: 2 * MINUTE } });
    expect(arranged.units.map((unit) => unit.map((item) => item.type))).toEqual([['content', 'flex'], ['content', 'flex']]);
    expect(arranged.units.flat()).toEqual(arranged.items);
  });
});

describe('starting exactly on time', () => {
  const lineup = filler(3);
  it('fills from the program boundary before the time with open airtime', () => {
    expect(exactBoundary(lineup, () => MONDAY, MONDAY + 90 * MINUTE, HOUR)).toEqual({ index: 1, start: MONDAY + 90 * MINUTE, gap: 30 * MINUTE });
    // On a boundary already: no gap.
    expect(exactBoundary(lineup, () => MONDAY, MONDAY + HOUR, HOUR)).toEqual({ index: 1, start: MONDAY + HOUR, gap: 0 });
  });

  it('lands on the time on a lineup that has repeated, whether or not what is on air is kept in place', () => {
    const start = MONDAY - 10 * 3 * HOUR;
    const at = MONDAY + 100 * MINUTE;
    const added = 2 * HOUR;
    const check = (startWith: (more: number) => number) => {
      const exact = exactBoundary(lineup, startWith, at, added);
      expect(exact).not.toBeNull();
      const next = [...lineup.slice(0, exact!.index), { type: 'flex', duration: exact!.gap }, { type: 'content', id: 'new', duration: added }, ...lineup.slice(exact!.index)];
      expect(Math.abs(airs(next, startWith(added + exact!.gap), exact!.index + 1, at) - at)).toBeLessThan(1000);
    };
    check(() => start);
    check((more) => keptStartTime(start, sum(lineup), sum(lineup) + more, MONDAY + 30 * MINUTE));
  });
});

describe('time slots', () => {
  const episodes = (count: number, minutes: number) => Array.from({ length: count }, (_, at): LineupItem[] => [{ type: 'content', id: `ep-${at + 1}`, duration: minutes * MINUTE }]);
  const startsOf = (placement: NonNullable<ReturnType<typeof placeInSlots>>, start: number) =>
    placement.slots.map((slot) => airs(placement.lineup, start, slot.index, slot.at) + slot.gap);

  it('lists slot times on the chosen weekdays, at the same clock time', () => {
    const times = slotTimes({ day: '2026-10-19', time: '20:00', weekdays: [1, 3] }, 3);
    expect(times.map((at) => new Date(at).toString().slice(0, 21))).toEqual(['Mon Oct 19 2026 20:00', 'Wed Oct 21 2026 20:00', 'Mon Oct 26 2026 20:00']);
    expect(slotTimes({ day: '2026-10-19', time: '20:00', weekdays: [] })).toEqual([]);
    expect(slotWindow('18:00', '20:00')).toBe(2 * HOUR);
    expect(slotWindow('23:00', '01:00')).toBe(2 * HOUR);
  });

  it('starts each slot on time, in order, pushing what was there later', () => {
    const lineup = filler(24 * 10);
    const placement = placeInSlots(lineup, () => MONDAY, episodes(3, 22), { day: '2026-10-19', time: '20:30', weekdays: [0, 1, 2, 3, 4, 5, 6], fill: { kind: 'count', count: 1 } })!;
    expect(placement.slots).toHaveLength(3);
    expect(startsOf(placement, MONDAY)).toEqual(placement.slots.map((slot) => slot.at));
    expect(placement.slots.map((slot) => placement.lineup[slot.index + 1].id)).toEqual(['ep-1', 'ep-2', 'ep-3']);
    // The open airtime in front of each slot is never more than the program it stands in for.
    expect(placement.slots.every((slot) => slot.gap > 0 && slot.gap < HOUR)).toBe(true);
    expect(placement.gaps).toBe(placement.slots.reduce((total, slot) => total + slot.gap, 0));
    expect(placement).toMatchObject({ placed: 3, left: 0, stopped: undefined });
    // Nothing is taken out.
    expect(placement.lineup.filter((item) => item.id?.startsWith('old-'))).toHaveLength(lineup.length);
  });

  it('fills a window with as many programs as fit', () => {
    const placement = placeInSlots(filler(24 * 10), () => MONDAY, episodes(5, 25), { day: '2026-10-19', time: '20:00', weekdays: [0, 1, 2, 3, 4, 5, 6], fill: { kind: 'until', until: '21:00' } })!;
    expect(placement.slots.map((slot) => slot.programs)).toEqual([2, 2, 1]);
  });

  it('stops where the lineup repeats, since a slot in the next pass would move the earlier ones', () => {
    const placement = placeInSlots(filler(24), () => MONDAY, episodes(5, 22), { day: '2026-10-19', time: '20:00', weekdays: [0, 1, 2, 3, 4, 5, 6], fill: { kind: 'count', count: 1 } })!;
    expect(placement.slots).toHaveLength(1);
    expect(placement).toMatchObject({ placed: 1, left: 4, stopped: { reason: 'repeats' } });
  });

  it('places only one slot on a repeated lineup unless what is on air stays in place', () => {
    const lineup = filler(72);
    const start = MONDAY - 10 * 72 * HOUR;
    const plan = { day: '2026-10-19', time: '20:00', weekdays: [0, 1, 2, 3, 4, 5, 6], fill: { kind: 'count' as const, count: 1 } };
    expect(placeInSlots(lineup, () => start, episodes(2, 22), plan)).toMatchObject({ placed: 1, stopped: { reason: 'moves' } });
    const startWith = (more: number) => keptStartTime(start, sum(lineup), sum(lineup) + more, MONDAY + HOUR);
    const kept = placeInSlots(lineup, startWith, episodes(2, 22), plan)!;
    expect(kept).toMatchObject({ placed: 2, left: 0 });
    expect(startsOf(kept, startWith(sum(kept.lineup) - sum(lineup))).map((at) => Math.round(at / 1000))).toEqual(kept.slots.map((slot) => slot.at / 1000));
  });
});
