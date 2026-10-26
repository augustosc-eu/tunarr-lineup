// The desk's side of the compatibility report (server/compatibility.ts): what
// to call each state, whether a feature must be refused, and the diagnostics
// file. Pure; only types come from the server.
import type { CapabilityId, CapabilityPart, CapabilityStatus, CompatibilityReport, PartId, PartStatus } from '../server/compatibility';

export type { CapabilityId, CapabilityPart, CapabilityStatus, CompatibilityReport, PartId, PartStatus };

export const STATUS_LABELS: Record<CapabilityStatus, string> = {
  available: 'Available',
  // Usable, but not all of it: a part is missing, its writes weren't checked, or it answered oddly (the reason says which).
  degraded: 'Limited',
  unavailable: 'Not available',
  untested: 'Not checked',
  unknown: 'Unknown',
};

/**
 * Why a feature is refused, or null. Only "unavailable" refuses: a feature that
 * answers oddly, wasn't checked or couldn't be checked stays usable, so one
 * missing capability never blocks the others.
 */
export function blockedReason(report: CompatibilityReport | null | undefined, id: CapabilityId): string | null {
  // Anything that isn't a report (an older companion, an error page) refuses nothing.
  const capability = Array.isArray(report?.capabilities) ? report.capabilities.find((item) => item.id === id) : undefined;
  return capability?.status === 'unavailable' ? `${capability.label} isn’t available on this Tunarr. ${capability.reason}` : null;
}

/**
 * Why one part of a feature (a manager's create, edit or delete) is refused,
 * or null. Refused when the whole feature is, or when Tunarr's API description
 * was read and doesn't list that part's route; a part that couldn't be
 * checked stays usable.
 */
export function partBlocked(report: CompatibilityReport | null | undefined, id: CapabilityId, part: PartId): string | null {
  const whole = blockedReason(report, id);
  if (whole) return whole;
  const capability = Array.isArray(report?.capabilities) ? report.capabilities.find((item) => item.id === id) : undefined;
  const missing = Array.isArray(capability?.parts) ? capability.parts.find((item) => item.id === part && item.status === 'unavailable') : undefined;
  return missing ? `This Tunarr’s API doesn’t offer ${missing.label}, so it’s turned off here.` : null;
}

/** What a dialog asks to know whether one of its actions is refused: `partBlocked` on the desk's report (nothing is refused outside live mode). */
export type PartBlocker = (id: CapabilityId, part: PartId) => string | null;

/** The distinct reasons the actions asked about are refused, for a dialog's "not on this Tunarr" note. */
export const refusedParts = (blocked: PartBlocker | undefined, parts: Array<[CapabilityId, PartId]>) => [...new Set(parts.map(([id, part]) => blocked?.(id, part)).filter((reason): reason is string => !!reason))];

/** The parts of each capability the desk refuses, for the "turned off" list. */
export const blockedParts = (report: CompatibilityReport | null | undefined) => (Array.isArray(report?.capabilities) ? report.capabilities : [])
  .filter((item) => item.status !== 'unavailable' && Array.isArray(item.parts) && item.parts.some((part) => part.status === 'unavailable'))
  .map((item) => ({ id: item.id, label: item.label, parts: item.parts!.filter((part) => part.status === 'unavailable') }));

/** Capabilities the desk refuses, for the "turned off" list. */
export const blockedCapabilities = (report: CompatibilityReport | null | undefined) => (Array.isArray(report?.capabilities) ? report.capabilities : []).filter((item) => item.status === 'unavailable');

/** One line for the connection dialog and Test Connection. */
export function versionLine(version: string | null, status: CompatibilityReport['version']['status']) {
  if (!version) return 'Version unknown';
  return status === 'validated' ? `Tunarr ${version}` : status === 'unvalidated' ? `Tunarr ${version} (not validated)` : `Tunarr ${version} (unrecognized version)`;
}

/**
 * The diagnostics file: the report and when it was exported. The report never
 * names Tunarr's address or credentials (its reasons are Lineup's own words),
 * and nothing else is added, so the file can be shared when asking for help.
 */
export function diagnosticsFile(report: CompatibilityReport, exportedAt = Date.now()) {
  return {
    format: 'tunarr-lineup-diagnostics',
    // 2: capabilities may list their parts (what a manager can create, edit or delete).
    formatVersion: 2,
    exportedAt: new Date(exportedAt).toISOString(),
    checkedAt: new Date(report.checkedAt).toISOString(),
    configured: report.configured,
    connected: report.connected,
    ...(report.connectionError ? { connectionError: report.connectionError } : {}),
    tunarrVersion: report.version,
    apiDescription: report.apiDescription,
    capabilities: report.capabilities.map(({ id, label, status, reason, parts }) => ({ id, label, status, reason, ...(parts?.length ? { parts: parts.map(({ id: part, label: partLabel, status: partStatus }) => ({ id: part, label: partLabel, status: partStatus })) } : {}) })),
  };
}
