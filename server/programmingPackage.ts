// A programming package (roadmap milestone 3): several channels' lineups in
// one versioned file, to move programming between channels or Tunarr servers.
// Lineup items travel untouched (invariant 3), with just enough program detail
// to title them (slimPrograms); nothing else from Tunarr goes in, so no
// addresses, tokens, media paths or settings. Importing validates the file and
// goes through the batch flow: preview, snapshot, conditional save per channel.
import { lineupItemsError, slimPrograms } from './lineupItems.js';
import { lineupLength, programmingVersion } from './lineupVersion.js';

export const PACKAGE_FORMAT = 'tunarr-lineup-package';
export const PACKAGE_VERSION = 1;
export const MAX_PACKAGE_CHANNELS = 50;
export const MAX_PACKAGE_ITEMS = 200_000;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type PackageChannel = {
  /** The channel's id where it was exported (used to map it onto a channel here). */
  id: string;
  number: number;
  name: string;
  /** The programming version it was exported at, for reference. */
  version: string;
  /** It came from a slot schedule; the package holds its lineup only. */
  hadSchedule: boolean;
  lineup: Array<Record<string, unknown>>;
  programs: Record<string, Record<string, unknown>>;
};

export type ProgrammingPackage = { format: typeof PACKAGE_FORMAT; version: typeof PACKAGE_VERSION; exportedAt: string; channels: PackageChannel[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

/** One channel's entry, from Tunarr's channel and programming replies. */
export function packageChannel(channel: { id: string; number: number; name: string }, programming: unknown): PackageChannel {
  const current = isObject(programming) ? programming : {};
  const lineup = (Array.isArray(current.lineup) ? current.lineup : []).filter(isObject);
  return {
    id: channel.id,
    number: channel.number,
    name: channel.name.slice(0, 200),
    version: programmingVersion(current.lineup, current.schedule),
    hadSchedule: current.schedule != null,
    lineup,
    programs: slimPrograms(lineup, current.programs),
  };
}

export const buildPackage = (channels: PackageChannel[], now = Date.now()): ProgrammingPackage => ({ format: PACKAGE_FORMAT, version: PACKAGE_VERSION, exportedAt: new Date(now).toISOString(), channels });

/** The package, checked: its format and version, and every lineup item one Tunarr can save. */
export function validatePackage(raw: unknown): { package: ProgrammingPackage } | { error: string } {
  if (!isObject(raw) || raw.format !== PACKAGE_FORMAT) return { error: 'This isn’t a Tunarr Lineup programming package.' };
  if (raw.version !== PACKAGE_VERSION) return { error: `This package is version ${String(raw.version).slice(0, 10)}; this Lineup reads version ${PACKAGE_VERSION}.` };
  if (!Array.isArray(raw.channels) || !raw.channels.length) return { error: 'The package has no channels.' };
  if (raw.channels.length > MAX_PACKAGE_CHANNELS) return { error: `A package holds up to ${MAX_PACKAGE_CHANNELS} channels.` };
  let items = 0;
  const seen = new Set<string>();
  const channels: PackageChannel[] = [];
  for (const [index, entry] of raw.channels.entries()) {
    const where = `Channel ${index + 1} in the package`;
    if (!isObject(entry)) return { error: `${where} isn’t an object.` };
    if (typeof entry.id !== 'string' || !CHANNEL_ID.test(entry.id) || seen.has(entry.id)) return { error: `${where} has a missing or repeated id.` };
    seen.add(entry.id);
    if (!Number.isInteger(entry.number) || typeof entry.name !== 'string') return { error: `${where} needs a number and a name.` };
    const problem = lineupItemsError(entry.lineup, `${where}: item`);
    if (problem) return { error: problem };
    items += (entry.lineup as unknown[]).length;
    if (items > MAX_PACKAGE_ITEMS) return { error: `A package holds up to ${MAX_PACKAGE_ITEMS.toLocaleString('en')} items.` };
    if (!(entry.lineup as unknown[]).length) return { error: `${where} has an empty lineup.` };
    channels.push({
      id: entry.id, number: entry.number as number, name: entry.name.slice(0, 200),
      version: typeof entry.version === 'string' ? entry.version.slice(0, 80) : '', hadSchedule: entry.hadSchedule === true,
      lineup: entry.lineup as Array<Record<string, unknown>>,
      // Only titles travel: anything else in "programs" is dropped.
      programs: slimPrograms(entry.lineup, isObject(entry.programs) ? entry.programs : {}),
    });
  }
  return { package: { format: PACKAGE_FORMAT, version: PACKAGE_VERSION, exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt.slice(0, 40) : '', channels } };
}

/** What an import would change on one channel. */
export const importSummary = (before: unknown[], after: unknown[]) => ({ itemsBefore: before.length, itemsAfter: after.length, lengthBefore: lineupLength(before), lengthAfter: lineupLength(after) });
