import { describe, expect, it } from 'vitest';
import {
  buildManualSave,
  dayRange,
  hasGeneratedSchedule,
  instancesForDay,
  instancesFromGuide,
  lineupIndexAt,
  reorderLineup,
  scheduleForDay,
} from '../lib/lineup';
import { guideFor, MINUTE, mixedLineup } from './fixtures';

describe('reorderLineup', () => {
  it('moves an item before another without adding or dropping items', () => {
    const lineup = mixedLineup();
    const result = reorderLineup(lineup, 5, 1)!;
    expect(result.lineup.map((item) => item.type)).toEqual(['content', 'content', 'flex', 'custom', 'filler', 'redirect']);
    expect(result.lineup[1]).toBe(lineup[5]);
    expect(result.selectedIndex).toBe(1);
    expect([...result.lineup].sort((a, b) => lineup.indexOf(a) - lineup.indexOf(b))).toEqual(lineup);
  });

  it('swaps two items', () => {
    const lineup = mixedLineup();
    const result = reorderLineup(lineup, 0, 4, true)!;
    expect(result.lineup[0]).toBe(lineup[4]);
    expect(result.lineup[4]).toBe(lineup[0]);
    expect(result.selectedIndex).toBe(4);
  });

  it('ignores no-op and out-of-range moves', () => {
    expect(reorderLineup(mixedLineup(), 2, 2)).toBeNull();
    expect(reorderLineup(mixedLineup(), -1, 2)).toBeNull();
    expect(reorderLineup(mixedLineup(), 0, 99)).toBeNull();
  });
});

describe('buildManualSave', () => {
  it('preserves flex, redirect, custom-show, filler and content objects exactly', () => {
    const lineup = mixedLineup();
    const reordered = reorderLineup(lineup, 0, 5, true)!.lineup;
    const { request, skipped } = buildManualSave(reordered);
    expect(skipped).toBe(0);
    expect(request).toEqual({ type: 'manual', lineup: reordered, append: false });
    // Each object survives JSON serialization field-for-field.
    const sent = JSON.parse(JSON.stringify(request));
    expect(sent.lineup).toEqual(JSON.parse(JSON.stringify(reordered)));
    expect(sent.lineup[0]).toEqual({ type: 'content', id: 'prog-bravo', duration: 40 * MINUTE, persisted: true, startOffsetMs: 120000 });
    expect(sent.lineup.find((item: { type: string }) => item.type === 'flex')).toEqual({ type: 'flex', duration: 10 * MINUTE, persisted: true, fillerConfig: { fillerListIds: ['8f3c1b2a-0000-4000-8000-000000000001'], origin: 'flex' } });
    expect(sent.lineup.find((item: { type: string }) => item.type === 'redirect')).toEqual({ type: 'redirect', channel: 'ch-two', channelNumber: 2, channelName: 'Channel Two', duration: 25 * MINUTE, persisted: true });
    expect(sent.lineup.find((item: { type: string }) => item.type === 'custom')).toEqual({ type: 'custom', id: 'prog-custom', customShowId: 'cs-1', index: 3, duration: 20 * MINUTE, persisted: true });
    expect(sent.lineup.find((item: { type: string }) => item.type === 'filler')).toEqual({ type: 'filler', id: '8f3c1b2a-0000-4000-8000-000000000002', fillerListId: '8f3c1b2a-0000-4000-8000-000000000001', fillerType: 'pre', duration: 15 * MINUTE });
  });

  it('leaves out zero-length items Tunarr cannot store and reports them', () => {
    const lineup = [...mixedLineup(), { type: 'content', id: 'empty', duration: 0 }];
    const { request, skipped } = buildManualSave(lineup);
    expect(skipped).toBe(1);
    expect(request.lineup).toHaveLength(6);
  });
});

describe('generated schedule detection', () => {
  it('flags channels with a slot or time schedule', () => {
    expect(hasGeneratedSchedule({ schedule: { type: 'time', slots: [] } })).toBe(true);
    expect(hasGeneratedSchedule({ schedule: undefined })).toBe(false);
    expect(hasGeneratedSchedule({})).toBe(false);
  });
});

describe('guide mapping', () => {
  const lineup = mixedLineup();
  const date = '2026-10-02';
  const { from, to } = dayRange(date);
  const startTime = from.getTime() - 7 * MINUTE;

  it('finds the lineup entry airing at a time', () => {
    expect(lineupIndexAt(lineup, startTime, startTime)).toBe(0);
    expect(lineupIndexAt(lineup, startTime, startTime + 35 * MINUTE)).toBe(1);
    expect(lineupIndexAt(lineup, startTime, startTime + 140 * MINUTE + 1)).toBe(0);
  });

  it('ties every guide entry back to its lineup index', () => {
    const guide = guideFor(lineup, startTime, from.getTime(), to.getTime());
    const rows = instancesFromGuide(guide, lineup, startTime, date);
    expect(rows.length).toBe(guide.length);
    expect(rows.every((row) => row.lineupIndex >= 0)).toBe(true);
    expect(rows.map((row) => row.start)).toEqual(instancesForDay(lineup, startTime, date).map((row) => row.start));
  });

  it('matches by program id when the guide has drifted from the lineup', () => {
    const guide = guideFor(lineup, startTime + 3 * MINUTE, from.getTime(), to.getTime());
    const rows = instancesFromGuide(guide, lineup, startTime, date);
    const bravo = rows.find((row) => row.item.id === 'prog-bravo')!;
    expect(bravo.lineupIndex).toBe(5);
  });

  it('uses the projection when Tunarr’s guide does not match the lineup', () => {
    const stale = [{ type: 'flex', start: from.getTime(), stop: from.getTime() + 6 * 60 * MINUTE, title: 'Channel' }];
    const schedule = scheduleForDay(stale, lineup, startTime, date);
    expect(schedule.guideStale).toBe(true);
    expect(schedule.rows).toEqual(instancesForDay(lineup, startTime, date));
  });

  it('merges guide rows with the projection outside the guide window', () => {
    const windowStart = from.getTime() + 6 * 60 * MINUTE;
    const guide = guideFor(lineup, startTime, windowStart, windowStart + 4 * 60 * MINUTE);
    const schedule = scheduleForDay(guide, lineup, startTime, date);
    expect(schedule.guideStale).toBe(false);
    expect(schedule.guideWindow!.start).toBeLessThanOrEqual(windowStart);
    expect(schedule.rows.map((row) => row.start)).toEqual(instancesForDay(lineup, startTime, date).map((row) => row.start));
  });

  it('keeps entries Tunarr inserted itself as read-only rows', () => {
    const guide = guideFor(lineup, startTime, from.getTime(), to.getTime());
    guide[2] = { ...guide[2], type: 'content', id: 'inserted-filler', title: 'Inserted Bumper' };
    const rows = instancesFromGuide(guide, lineup, startTime, date);
    expect(rows[2].lineupIndex).toBe(-1);
    expect(rows[2].title).toBe('Inserted Bumper');
  });
});
