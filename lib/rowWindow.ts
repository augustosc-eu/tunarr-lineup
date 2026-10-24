// Which of a day's rows the timeline mounts. A day of short spots can hold
// thousands of rows; mounting them all makes every key press re-render
// thousands of buttons. Up to ROW_WINDOW rows are mounted, and the window
// follows the cursor, so arrow keys and the remote still reach every row.

export const ROW_WINDOW = 200;
/** How far "Show earlier" / "Show later" (or scrolling to an edge) moves the window. */
export const ROW_STEP = 100;

export type RowRange = { start: number; end: number };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/**
 * Rows [start, end) of `total`: all of them when they fit, else `size` rows
 * from `preferred` (where the user last moved the window), moved only as far
 * as needed to hold `focus` (the cursor, or what's on air). Without a
 * preferred start, the focus sits a third of the way down. A focus of -1
 * leaves the window wherever `preferred` puts it.
 */
export function rowWindow(total: number, focus: number, preferred: number | null, size = ROW_WINDOW): RowRange {
  if (total <= size) return { start: 0, end: total };
  const last = total - size;
  let start = preferred === null ? clamp(focus - Math.floor(size / 3), 0, last) : clamp(preferred, 0, last);
  if (focus >= 0 && (focus < start || focus >= start + size)) start = clamp(focus - Math.floor(size / 3), 0, last);
  return { start, end: start + size };
}

/** The window moved by `step` rows (negative for earlier), within the day. */
export function shiftWindow(range: RowRange, total: number, step: number, size = ROW_WINDOW): RowRange {
  const start = clamp(range.start + step, 0, Math.max(total - size, 0));
  return { start, end: Math.min(start + size, total) };
}
