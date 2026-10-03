import type { GuideProgram, LineupItem, Programming } from '../lib/lineup';

export const MINUTE = 60_000;

/** One of every Tunarr lineup item type, each carrying extra fields that must survive a save. */
export const mixedLineup = (): LineupItem[] => [
  { type: 'content', id: 'prog-alpha', duration: 30 * MINUTE, persisted: true, startOffsetMs: 0, icon: undefined },
  { type: 'flex', duration: 10 * MINUTE, persisted: true, fillerConfig: { fillerListIds: ['8f3c1b2a-0000-4000-8000-000000000001'], origin: 'flex' } },
  { type: 'custom', id: 'prog-custom', customShowId: 'cs-1', index: 3, duration: 20 * MINUTE, persisted: true },
  { type: 'filler', id: '8f3c1b2a-0000-4000-8000-000000000002', fillerListId: '8f3c1b2a-0000-4000-8000-000000000001', fillerType: 'pre', duration: 15 * MINUTE },
  { type: 'redirect', channel: 'ch-two', channelNumber: 2, channelName: 'Channel Two', duration: 25 * MINUTE, persisted: true },
  { type: 'content', id: 'prog-bravo', duration: 40 * MINUTE, persisted: true, startOffsetMs: 120000 },
];

export const mixedPrograms = (): Programming['programs'] => ({
  'prog-alpha': { type: 'content', id: 'prog-alpha', duration: 30 * MINUTE, program: { type: 'movie', title: 'Alpha Movie', year: 2001 } } as never,
  'prog-bravo': { type: 'content', id: 'prog-bravo', duration: 40 * MINUTE, program: { type: 'episode', title: 'Pilot', show: { title: 'Bravo Show' }, season: { index: 1 }, episodeNumber: 1 } } as never,
  'prog-custom': { type: 'content', id: 'prog-custom', duration: 20 * MINUTE, program: { type: 'movie', title: 'Custom Feature' } } as never,
  '8f3c1b2a-0000-4000-8000-000000000002': { type: 'content', id: 'x', duration: 15 * MINUTE, program: { type: 'other_video', title: 'Station Bumper' } } as never,
});

/** Builds Tunarr-style guide entries for [from, to) by walking the cycle. */
export function guideFor(lineup: LineupItem[], startTime: number, from: number, to: number): GuideProgram[] {
  const cycle = lineup.reduce((sum, item) => sum + item.duration, 0);
  let cursor = startTime + Math.floor((from - startTime) / cycle) * cycle;
  const result: GuideProgram[] = [];
  while (cursor < to) {
    for (const item of lineup) {
      const start = cursor;
      const stop = start + item.duration;
      cursor = stop;
      if (stop <= from || start >= to) continue;
      if (item.type === 'flex') result.push({ type: 'flex', start, stop, duration: item.duration, title: 'Flex' });
      else if (item.type === 'redirect') result.push({ ...item, start, stop });
      else result.push({ type: item.type === 'custom' ? 'custom' : 'content', id: item.id, start, stop, duration: item.duration });
    }
  }
  return result;
}
