// The roles a filler list can play on air. Pure: shared by the companion's
// validation (fillerRoleStore.ts, lineupRoutes.ts) and the browser (lib/fillerRoles.ts).

export const FILLER_ROLES = ['station-id', 'commercials', 'promos', 'bumpers', 'other'] as const;
export type FillerRole = (typeof FILLER_ROLES)[number];
/** Filler-list id → role. */
export type FillerRoles = Record<string, FillerRole>;

export const ROLE_LABELS: Record<FillerRole, string> = {
  'station-id': 'Station IDs',
  commercials: 'Commercials',
  promos: 'Promos',
  bumpers: 'Bumpers',
  other: 'Other filler',
};

export const isFillerRole = (value: unknown): value is FillerRole => typeof value === 'string' && (FILLER_ROLES as readonly string[]).includes(value);

/** A filler list kept in step with a folder (a Tunarr library); `builtAt` is when it was last read. */
export type FillerLink = { mediaSourceId: string; libraryId: string; builtAt?: number };
/** Filler-list id → the library it is built from. */
export type FillerLinks = Record<string, FillerLink>;
/** A folder added with a role whose list is made once Tunarr has scanned it. */
export type PendingFolder = { mediaSourceId: string; role: FillerRole; name: string };
/** What Lineup follows: lists built from folders, folders waiting for their list, and libraries never to pick up again. */
export type FillerFolders = { links: FillerLinks; pending: Record<string, PendingFolder>; ignored: string[] };

const IDENT = /\bids?\b|ident|identificador|cortina|sign[- ]?(on|off)|top of (the )?hour/i;
const PROMO = /promo|trailer|coming up|next on|avance/i;
const BUMPER = /bumper|bump|interstitial|separador/i;
const COMMERCIAL = /commercial|\bads?\b|advert|\bspots?\b|tanda|anuncio|publicidad|comercial/i;

/**
 * A suggestion from the list's name, used only when no role is stored.
 * "Station" alone means IDs only when nothing more specific matches ("Station Ads").
 */
export function guessRole(name: string): FillerRole | undefined {
  if (IDENT.test(name)) return 'station-id';
  if (PROMO.test(name)) return 'promos';
  if (BUMPER.test(name)) return 'bumpers';
  if (COMMERCIAL.test(name)) return 'commercials';
  if (/station/i.test(name)) return 'station-id';
  return undefined;
}

const FOLDER_WORDS: Array<[FillerRole, string[]]> = [
  ['station-id', ['ids', 'idents', 'stationids', 'identificadores', 'cortinas']],
  ['commercials', ['commercials', 'commercial', 'ads', 'adverts', 'advertisements', 'spots', 'tandas', 'anuncios', 'publicidad', 'comerciales']],
  ['promos', ['promos', 'promo', 'trailers']],
  ['bumpers', ['bumpers', 'bumper', 'bumps', 'interstitials', 'separadores']],
  ['other', ['filler', 'fillers', 'other-filler']],
];

/**
 * The role a folder or library is plainly named for ("Commercials",
 * "/media/station-ids", "Station IDs"), or undefined. Whole words of the last
 * path segment only, so automatic pickup never takes "Accidents" for idents.
 */
export function folderRole(name: string): FillerRole | undefined {
  const segment = name.split(/[\\/]/).filter(Boolean).pop() ?? '';
  const words = segment.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.includes('station') && (words.includes('id') || words.includes('ids'))) return 'station-id';
  if (segment.toLowerCase() === 'other-filler') return 'other';
  return FOLDER_WORDS.find(([, list]) => words.some((word) => list.includes(word)))?.[0];
}
