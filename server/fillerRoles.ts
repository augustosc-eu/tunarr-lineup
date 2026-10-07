// The roles a filler list can play on air. Pure: shared by the companion's
// validation (fillerRoleStore.ts, lineupRoutes.ts) and the browser (lib/fillerRoles.ts).

export const FILLER_ROLES = ['station-id', 'commercials', 'promos', 'bumpers', 'other'] as const;
export type FillerRole = (typeof FILLER_ROLES)[number];
/** Filler-list id → role. */
export type FillerRoles = Record<string, FillerRole>;

export const isFillerRole = (value: unknown): value is FillerRole => typeof value === 'string' && (FILLER_ROLES as readonly string[]).includes(value);
