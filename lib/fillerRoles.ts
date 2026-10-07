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

/** Lowercase words and numbers, accents dropped, letters split from digits ("EL109" → el, 109). */
export function nameTokens(name: string): string[] {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/\p{L}+|\p{N}+/gu) ?? [];
}

/**
 * The channel a station ID is named for: the channel whose whole name appears
 * in the ID's title, word for word ("EL 7 ID.mp4" → El 7, "EL109 ID B" → El 109,
 * but "JDRAMA TV ID" is not Drama TV). The longest matching name wins.
 */
export function idChannel<C extends { id: string; name: string }>(title: string, channels: C[]): C | undefined {
  const words = nameTokens(title);
  let best: C | undefined;
  let bestLength = 0;
  for (const channel of channels) {
    const name = nameTokens(channel.name);
    if (!name.length || name.length <= bestLength) continue;
    const found = words.some((_, start) => name.every((word, offset) => words[start + offset] === word));
    if (found) {
      best = channel;
      bestLength = name.length;
    }
  }
  return best;
}

/**
 * The station IDs a channel airs: those named for it, plus those in its own
 * station-ID lists (ticked in Channel Settings, so in its Tunarr filler) that
 * aren't named for another channel. A channel with none gets the IDs named for
 * no channel, never another channel's.
 */
export function channelStationIds<T extends { id: string }>(
  byList: Record<string, T[]>,
  assignedListIds: string[],
  channel: { id: string; name: string } | undefined,
  channels: Array<{ id: string; name: string }>,
  titleOf: (id: T) => string,
): { ids: T[]; own: boolean } {
  // One entry per ID, with every list that holds it.
  const entries = new Map<string, { id: T; lists: string[]; owner?: string }>();
  for (const [list, ids] of Object.entries(byList)) {
    for (const id of ids) {
      const entry = entries.get(id.id);
      if (entry) entry.lists.push(list);
      else entries.set(id.id, { id, lists: [list], owner: idChannel(titleOf(id), channels)?.id });
    }
  }
  const all = [...entries.values()];
  const own = channel ? all.filter((entry) => entry.owner === channel.id || (!entry.owner && entry.lists.some((list) => assignedListIds.includes(list)))) : [];
  return own.length ? { ids: own.map((entry) => entry.id), own: true } : { ids: all.filter((entry) => !entry.owner).map((entry) => entry.id), own: false };
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
