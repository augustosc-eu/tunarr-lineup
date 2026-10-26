// The desk's side of batch operations (server/batch.ts): names for each
// operation and outcome, the defaults the dialog fills in, and what can be
// rolled back. Pure; the companion validates everything again.
import type { BatchPreview, MissingProgram, PreviewChannel, RepairDecision } from '../server/batch';
import type { BatchChannel, BatchOperation, BatchRecord, BatchSummary, ChannelOutcome } from '../server/batchStore';
import type { PackageChannel } from '../server/programmingPackage';

export type { BatchChannel, BatchOperation, BatchPreview, BatchRecord, BatchSummary, ChannelOutcome, MissingProgram, PackageChannel, PreviewChannel, RepairDecision };

/** What the dialog offers: every batch operation, plus exporting (read-only, no preview). */
export type BatchTask = BatchOperation | 'export';

export const TASKS: Array<{ id: BatchTask; label: string; help: string }> = [
  { id: 'filler', label: 'Copy filler settings', help: 'Give the channels another channel’s filler lists, repeat cooldown and watermark setting.' },
  { id: 'group', label: 'Change group title', help: 'Set the group title (the network) of every channel picked.' },
  { id: 'transcode', label: 'Change transcode profile', help: 'Put the channels on one transcode profile.' },
  { id: 'renumber', label: 'Renumber channels', help: 'Give each channel a new number; numbers already used by other channels are refused.' },
  { id: 'settings', label: 'Change channel options', help: 'Hidden, on demand, subtitles, stream format and guide options, on every channel picked.' },
  { id: 'repair', label: 'Repair missing media', help: 'Find programs Tunarr no longer has and remove them, keep their time as flex, or replace them with programs from the library.' },
  { id: 'export', label: 'Export a programming package', help: 'Download the channels’ lineups as one file (no addresses, tokens or settings).' },
  { id: 'import', label: 'Import a programming package', help: 'Put lineups from a package onto channels here, each previewed and saved conditionally.' },
];

export const OUTCOME_LABELS: Record<ChannelOutcome, string> = { pending: 'Waiting', done: 'Saved', unchanged: 'No change', conflict: 'Conflict', blocked: 'Blocked', failed: 'Failed', skipped: 'Not tried' };
export const PREVIEW_LABELS: Record<PreviewChannel['status'], string> = { ready: 'Will change', unchanged: 'No change', blocked: 'Blocked' };
export const REPAIR_LABELS: Record<RepairDecision['action'], string> = { ignore: 'Leave it', remove: 'Remove', flex: 'Flex (keep times)', replace: 'Replace…' };

/** Maps an outcome onto the shared row states (health-* classes). */
export const outcomeTone = (status: ChannelOutcome | PreviewChannel['status']): 'healthy' | 'warning' | 'error' | 'unknown' => {
  switch (status) {
    case 'done': case 'ready': return 'healthy';
    case 'conflict': case 'skipped': return 'warning';
    case 'failed': case 'blocked': return 'error';
    default: return 'unknown';
  }
};

/** The channels a preview would change. */
export const readyChannels = (preview: BatchPreview | null) => (preview?.channels ?? []).filter((channel) => channel.status === 'ready');

/** What the apply checks each channel against, from the preview. */
export const expectations = (preview: BatchPreview) => Object.fromEntries(readyChannels(preview).flatMap((channel) => (channel.expect ? [[channel.channelId, channel.expect]] : [])));

type BatchBody = { operation: string; channelIds?: string[]; params: unknown };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The apply for a previewed batch: only the channels the preview would change,
 * each with the fingerprint it was previewed at, and the per-channel parts
 * (a renumbering's numbers, an import's mapping) cut to those channels. The
 * companion refuses an apply whose parts don't match its channels exactly.
 */
export function applyBody(body: BatchBody, preview: BatchPreview) {
  const channelIds = readyChannels(preview).map((channel) => channel.channelId);
  const ready = new Set(channelIds);
  const params = isRecord(body.params) ? body.params : {};
  const cut = body.operation === 'renumber' && isRecord(params.numbers) ? { ...params, numbers: Object.fromEntries(Object.entries(params.numbers).filter(([id]) => ready.has(id))) }
    : body.operation === 'import' && isRecord(params.mapping) ? { ...params, mapping: Object.fromEntries(Object.entries(params.mapping).filter(([, to]) => typeof to === 'string' && ready.has(to))) }
    : params;
  return { ...body, channelIds, params: cut, expect: expectations(preview), label: preview.label };
}

/** Consecutive numbers from `start`, in the order the channels are listed. */
export function sequentialNumbers(channelIds: string[], start: number, step = 1): Record<string, number> {
  return Object.fromEntries(channelIds.map((id, index) => [id, start + index * step]));
}

/** Where each packaged lineup goes by default: a channel with the same id, else the same number, else nowhere. */
export function defaultMapping(packaged: Array<Pick<PackageChannel, 'id' | 'number'>>, channels: Array<{ id: string; number: number }>): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const source of packaged) {
    const match = channels.find((channel) => channel.id === source.id && !used.has(channel.id)) ?? channels.find((channel) => channel.number === source.number && !used.has(channel.id));
    if (match) { mapping[source.id] = match.id; used.add(match.id); }
  }
  return mapping;
}

/** Channels of a finished batch that can still be rolled back. */
export const rollbackable = (record: BatchRecord) => record.channels.filter((channel) => channel.rollback?.status !== 'done' && (channel.status === 'done' || (channel.status === 'failed' && !!channel.before)));

/** True while a batch or its rollback is still running. */
export const inProgress = (record: BatchRecord & { running?: boolean }) => !record.finishedAt || !!record.running || record.channels.some((channel) => channel.rollback?.message === 'Rolling back…');

/** One line for a finished batch: "3 saved, 1 conflict". */
export function outcomeLine(counts: Partial<Record<ChannelOutcome, number>>) {
  const parts = (Object.keys(OUTCOME_LABELS) as ChannelOutcome[]).filter((status) => counts[status]).map((status) => `${counts[status]} ${OUTCOME_LABELS[status].toLowerCase()}`);
  return parts.join(', ') || 'Nothing';
}

export const countOutcomes = (record: BatchRecord) => record.channels.reduce<Partial<Record<ChannelOutcome, number>>>((counts, channel) => ({ ...counts, [channel.status]: (counts[channel.status] ?? 0) + 1 }), {});

/** Default decision for every missing program: leave it, until someone chooses. */
export const defaultDecisions = (missing: MissingProgram[], current: Record<string, RepairDecision>) => Object.fromEntries(missing.map((item) => [item.programId, current[item.programId] ?? { action: 'ignore' as const }]));

export const durationLabel = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min` : `${minutes} min`;
};
