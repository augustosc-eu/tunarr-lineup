// A premiere: programs that join a manual lineup shortly before they start,
// so nothing of them airs earlier, and start exactly on time. Worked out when
// the scheduler runs it, against the lineup Tunarr has then (pure; no I/O).
import { keptStartTime } from './lineupVersion.js';

type Item = { duration: number };

/** Gaps shorter than this aren't worth a flex item. */
const MIN_GAP = 1000;

export type PremierePlacement = {
  /** Lineup position the items (after `gap` ms of flex) go in at. */
  index: number;
  gap: number;
  /** When the first item really starts, and the channel start that keeps what's on air in place. */
  start: number;
  startTime: number;
};

/**
 * Where items of `added` ms go so they start at `at`: the program boundary at
 * or before it in the pass airing now, with flex filling up to `at`. The
 * channel start moves by what every earlier pass gains, so everything up to
 * the boundary keeps its time (as "Keep what's on air in place" does). If the
 * program running into `at` has already begun, they start when it ends
 * instead, since Tunarr can't cut it short. Null when `at` has passed, the
 * lineup is empty, or `at` is beyond the end of the pass airing now (the
 * change ran too early; it's planned to run just before).
 */
export function premierePlacement(lineup: Item[], channelStart: number, now: number, at: number, added: number): PremierePlacement | null {
  const length = lineup.reduce((sum, item) => sum + item.duration, 0);
  if (!(length > 0) || !(added > 0) || at < now) return null;
  const passStart = channelStart + Math.max(0, Math.floor((now - channelStart) / length)) * length;
  const offset = at - passStart;
  // Past the end of this pass by more than a pass: too early to tell where it lands.
  if (offset >= 2 * length) return null;
  let index = 0;
  let cursor = 0;
  while (index < lineup.length && cursor + lineup[index].duration <= offset) {
    cursor += lineup[index].duration;
    index += 1;
  }
  if (passStart + cursor < now) {
    // The program running into `at` is on now: start right after it.
    cursor += lineup[index].duration;
    index += 1;
  }
  const raw = passStart + cursor >= at ? 0 : at - (passStart + cursor);
  const gap = raw >= MIN_GAP ? Math.round(raw) : 0;
  return { index, gap, start: passStart + cursor + gap, startTime: keptStartTime(channelStart, length, length + gap + added, now) };
}
