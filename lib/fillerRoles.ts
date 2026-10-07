// What a filler list is for on air. Tunarr's filler lists are just named
// programs, so Lineup keeps the role itself (LINEUP_DATA_DIR/filler-roles.json).
// Pure helpers for the browser; the role list itself is in server/fillerRoles.ts.

import { guessRole, type FillerRole, type FillerRoles } from '../server/fillerRoles';

export { FILLER_ROLES, folderRole, guessRole, isFillerRole, ROLE_LABELS, type FillerRole, type FillerRoles } from '../server/fillerRoles';

/** Singular, for a spot or a row badge. */
export const ROLE_SPOT_LABELS: Record<FillerRole, string> = {
  'station-id': 'Station ID',
  commercials: 'Commercial',
  promos: 'Promo',
  bumpers: 'Bumper',
  other: 'Filler',
};

/** The stored role, else the name's guess. */
export const roleOf = (list: { id: string; name: string }, roles: FillerRoles): FillerRole | undefined => roles[list.id] ?? guessRole(list.name);

export function listsWithRole<T extends { id: string; name: string }>(lists: T[], roles: FillerRoles, role: FillerRole): T[] {
  return lists.filter((list) => roleOf(list, roles) === role);
}

/** Broadcast-style spot length: ":15", ":30", "1:00", "2:30". */
export function spotLength(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return minutes ? `${minutes}:${rest}` : `:${rest}`;
}

/** How many spots of each length a list holds, shortest first ("4 × :30"). */
export function spotBreakdown(durations: number[]) {
  const counts = new Map<number, number>();
  for (const ms of durations) {
    const seconds = Math.round(ms / 1000);
    counts.set(seconds, (counts.get(seconds) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([seconds, count]) => ({ length: spotLength(seconds * 1000), count }));
}
