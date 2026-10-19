// Browser client for the companion's same-origin /api/tunarr routes. It never
// knows or contacts the Tunarr server's own address.
import type { Channel, ChannelLineup, ManualProgrammingRequest, Programming } from './lineup';
import type { RuleSet } from '../server/smartCollection';
import type { FillerFolders, FillerRole, FillerRoles } from '../server/fillerRoles';
import type { Template } from '../server/templateSchema';
import type { ChannelSettings, ContentProgram, ListSummary, ManagedSource, MediaSource, NamedItem, NewMediaSource, SearchResult, SmartCollectionView, TranscodeProfile } from './library';
import type { SchedulePreview, Slot, SlotSchedule } from './schedule';
import type { ChannelRef, RecreateResult as RecreatedChannel } from '../server/recreateChannel';
import type { ChangeSummary } from '../server/scheduler';
import type { Snapshot, SnapshotSummary } from '../server/snapshotStore';
import type { GuideChannel } from '../server/watch';
import type { Review } from '../server/ai';
import type { SettingsView } from '../server/settings';
import type { StationIdPicks } from '../server/stationIdStore';

export type ScheduleDraft = { type: SlotSchedule['type']; settings?: Record<string, unknown>; slots: Slot[]; extraPrograms?: string[] };
export type AiStatus = { enabled: true; provider: string; model: string } | { enabled: false; message: string };
export type AiProposal = { template: Template; lists: { commercials?: string; promos?: string }; notes: string };
export type MediaFile = { name: string; size: number; modifiedAt: number };
/** A role folder in the media folder, and its library in Tunarr once added. */
export type MediaRoleFolder = { role: FillerRole; folder: string; files: MediaFile[]; tunarr: { mediaSourceId: string; libraryId: string; lastScannedAt?: number; scanning: boolean } | null };
export type MediaFolderStatus = { enabled: true; maxBytes: number; folders: MediaRoleFolder[]; tunarrError?: string } | { enabled: false; message: string };
export type FillerSync = { connected: boolean; created: Array<{ id: string; name: string; count: number; role: FillerRole }>; updated: Array<{ id: string; count: number }>; errors: string[] };
export type { ChangeSummary, Review, SettingsView, Snapshot, SnapshotSummary, StationIdPicks };
export type ScheduledList = { enabled: boolean; message?: string; changes: ChangeSummary[] };
/** One change in a plan sent to the scheduler (server/scheduler.ts validatePlan). */
export type PlannedChange = {
  channelId: string;
  channelName: string;
  label: string;
  at: number;
  notAfter?: number;
  action:
    | { kind: 'lineup'; lineup: unknown[]; expectVersion: string }
    | { kind: 'patch'; index: number; remove: string[]; insert: unknown[] }
    | { kind: 'restore'; after: number | string };
  programs?: Record<string, unknown>;
};
export type ViewerCounts = Record<string, { viewers: number; streams: number }>;

/** The channel's live stream as HLS, through the companion (server/watch.ts). */
export const streamUrl = (channelId: string) => `/api/tunarr/channels/${encodeURIComponent(channelId)}/stream.m3u8`;
/** A media-folder file, played back by the companion (for previews). */
export const mediaFileUrl = (role: FillerRole, name: string) => `/api/tunarr/media-folder/${encodeURIComponent(role)}/${encodeURIComponent(name)}`;

export type LibraryQuery = { mediaSourceId: string; libraryId?: string; text?: string; type?: string; parentId?: string; page?: number; limit?: number };

const jsonBody = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export class TunarrApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly tunarrHost?: string,
  ) {
    super(message);
    this.name = 'TunarrApiError';
  }
}

export type ConnectionState =
  | { status: 'checking' }
  | { status: 'connected'; host: string; channelCount: number }
  | { status: 'not_configured'; message: string }
  | { status: 'unreachable'; host?: string; message: string }
  | { status: 'unavailable'; message: string };

type ErrorBody = { error?: { code?: string; message?: string; tunarrHost?: string } };

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...init?.headers } });
  } catch {
    throw new TunarrApiError(0, 'companion_unreachable', 'Could not reach the Lineup server.');
  }
  const data = await readJson(response);
  if (data === undefined) {
    throw new TunarrApiError(response.status, 'companion_unavailable', 'This deployment does not include the Tunarr companion server.');
  }
  if (!response.ok) {
    const error = (data as ErrorBody | null)?.error;
    throw new TunarrApiError(response.status, error?.code ?? 'http_error', error?.message ?? `Request failed (HTTP ${response.status}).`, error?.tunarrHost);
  }
  return data as T;
}

const mediaPath = (role: FillerRole, name: string) => `/api/tunarr/media-folder/${encodeURIComponent(role)}/${encodeURIComponent(name)}`;

/** Uploads one video into a role folder. XHR, because fetch can't report upload progress. */
export function uploadMediaFile(role: FillerRole, file: File, onProgress?: (fraction: number) => void): Promise<MediaFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', mediaPath(role, file.name));
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    xhr.onerror = () => reject(new TunarrApiError(0, 'upload_interrupted', 'The upload was interrupted. Check the connection and the Lineup server’s free disk space.'));
    xhr.onload = () => {
      let data: unknown;
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        data = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data as MediaFile);
      const error = (data as ErrorBody | null | undefined)?.error;
      reject(new TunarrApiError(xhr.status, error?.code ?? 'http_error', error?.message ?? `Upload failed (HTTP ${xhr.status}).`));
    };
    xhr.send(file);
  });
}

const channelPath = (id: string) => `/api/tunarr/channels/${encodeURIComponent(id)}`;

export async function checkHealth(): Promise<ConnectionState> {
  let response: Response;
  try {
    response = await fetch('/api/tunarr/health', { credentials: 'same-origin', headers: { accept: 'application/json' }, cache: 'no-store' });
  } catch {
    return { status: 'unreachable', message: 'Could not reach the Lineup server.' };
  }
  const data = (await readJson(response)) as (ErrorBody & { status?: string; tunarrHost?: string; channelCount?: number }) | null | undefined;
  if (!data || typeof data.status !== 'string') {
    return { status: 'unavailable', message: 'This copy of Lineup is a hosted preview without the Tunarr companion server.' };
  }
  if (data.status === 'connected' && response.ok) {
    return { status: 'connected', host: data.tunarrHost ?? 'Tunarr', channelCount: data.channelCount ?? 0 };
  }
  if (data.status === 'not_configured') {
    return { status: 'not_configured', message: data.error?.message ?? 'TUNARR_URL is not set on the Lineup server.' };
  }
  return { status: 'unreachable', host: data.tunarrHost, message: data.error?.message ?? 'Tunarr did not respond.' };
}

export const tunarrApi = {
  channels: () => request<Channel[]>('/api/tunarr/channels'),
  programming: (id: string) => request<Programming>(`${channelPath(id)}/programming`),
  /** `version` is the programming version the edit was based on (If-Match). */
  saveProgramming: (id: string, body: ManualProgrammingRequest, version: string) =>
    request<Programming>(`${channelPath(id)}/programming`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify(body),
    }),
  /** The channel's slot schedule with display details (show titles, names). */
  schedule: (id: string) => request<{ schedule?: SlotSchedule } | null>(`${channelPath(id)}/schedule`),
  previewSchedule: (id: string, draft: ScheduleDraft) =>
    request<SchedulePreview>(`${channelPath(id)}/schedule-preview`, jsonBody('POST', { type: draft.type, settings: draft.settings, slots: draft.slots, timeZoneOffset: new Date().getTimezoneOffset() })),
  saveSchedule: (id: string, draft: ScheduleDraft, preview: Pick<SchedulePreview, 'seed' | 'discardCount'>, version: string) =>
    request<Programming>(`${channelPath(id)}/programming`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify({
        type: draft.type,
        schedule: { settings: draft.settings, slots: draft.slots, timeZoneOffset: new Date().getTimezoneOffset() },
        extraPrograms: draft.extraPrograms?.length ? draft.extraPrograms : undefined,
        seed: preview.seed,
        discardCount: preview.discardCount,
      }),
    }),
  channelSettings: (id: string) => request<ChannelSettings>(`${channelPath(id)}/settings`),
  saveChannelSettings: (id: string, changes: Partial<ChannelSettings>) => request<ChannelSettings>(`${channelPath(id)}/settings`, jsonBody('PUT', changes)),
  mediaSources: () => request<MediaSource[]>('/api/tunarr/media-sources'),
  searchLibrary: (query: LibraryQuery) => request<SearchResult>('/api/tunarr/library/search', jsonBody('POST', query)),
  descendants: (programId: string) => request<ContentProgram[]>(`/api/tunarr/programs/${encodeURIComponent(programId)}/descendants`),
  smartCollections: () => request<NamedItem[]>('/api/tunarr/smart-collections'),
  fillerLists: () => request<ListSummary[]>('/api/tunarr/filler-lists'),
  fillerListPrograms: (id: string) => request<ContentProgram[]>(`/api/tunarr/filler-lists/${encodeURIComponent(id)}/programs`),
  createFillerList: (name: string, programs: ContentProgram[]) => request<{ id: string }>('/api/tunarr/filler-lists', jsonBody('POST', { name, programs })),
  updateFillerList: (id: string, body: { name?: string; programs?: ContentProgram[] }) => request<unknown>(`/api/tunarr/filler-lists/${encodeURIComponent(id)}`, jsonBody('PUT', body)),
  deleteFillerList: (id: string) => request<unknown>(`/api/tunarr/filler-lists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  customShows: () => request<ListSummary[]>('/api/tunarr/custom-shows'),
  customShowPrograms: (id: string) => request<ContentProgram[]>(`/api/tunarr/custom-shows/${encodeURIComponent(id)}/programs`),
  createCustomShow: (name: string, programs: ContentProgram[]) => request<{ id: string }>('/api/tunarr/custom-shows', jsonBody('POST', { name, programs })),
  updateCustomShow: (id: string, body: { name?: string; programs?: ContentProgram[] }) => request<unknown>(`/api/tunarr/custom-shows/${encodeURIComponent(id)}`, jsonBody('PUT', body)),
  deleteCustomShow: (id: string) => request<unknown>(`/api/tunarr/custom-shows/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  createChannel: (body: { name: string; number?: number; groupTitle?: string; transcodeConfigId?: string; copyFrom?: string }) =>
    request<{ id: string; name: string; number: number }>('/api/tunarr/channels/create', jsonBody('POST', body)),
  deleteChannel: (id: string) => request<unknown>(channelPath(id), { method: 'DELETE' }),
  /** Other channels whose lineup or slot schedule redirects to this one. */
  channelRedirects: (id: string) => request<{ redirects: ChannelRef[] }>(`${channelPath(id)}/recreate`),
  /** Recreates the channel without its slot schedule (Tunarr can't drop one); it gets a new id. */
  recreateChannel: (id: string, lineup: 'keep' | 'empty', version: string) =>
    request<RecreatedChannel>(`${channelPath(id)}/recreate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify({ lineup }),
    }),
  transcodeProfiles: () => request<TranscodeProfile[]>('/api/tunarr/transcode-configs'),
  saveTranscodeProfile: (id: string, changes: Partial<TranscodeProfile>) => request<TranscodeProfile>(`/api/tunarr/transcode-configs/${encodeURIComponent(id)}`, jsonBody('PUT', changes)),
  copyTranscodeProfile: (id: string) => request<TranscodeProfile>(`/api/tunarr/transcode-configs/${encodeURIComponent(id)}/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  deleteTranscodeProfile: (id: string) => request<unknown>(`/api/tunarr/transcode-configs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  managedSources: () => request<ManagedSource[]>('/api/tunarr/media-sources/manage'),
  addMediaSource: (source: NewMediaSource) => request<{ id: string }>('/api/tunarr/media-sources/add', jsonBody('POST', source)),
  deleteMediaSource: (id: string) => request<unknown>(`/api/tunarr/media-sources/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  refreshMediaSource: (id: string) => request<unknown>(`/api/tunarr/media-sources/${encodeURIComponent(id)}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  setLibraryEnabled: (sourceId: string, libraryId: string, enabled: boolean) =>
    request<{ id: string; enabled: boolean }>(`/api/tunarr/media-sources/${encodeURIComponent(sourceId)}/libraries/${encodeURIComponent(libraryId)}`, jsonBody('PUT', { enabled })),
  scanLibrary: (sourceId: string, libraryId: string) =>
    request<unknown>(`/api/tunarr/media-sources/${encodeURIComponent(sourceId)}/libraries/${encodeURIComponent(libraryId)}/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }),
  smartCollection: (id: string) => request<SmartCollectionView>(`/api/tunarr/smart-collections/${encodeURIComponent(id)}`),
  createSmartCollection: (body: { name: string; keywords?: string } & RuleSet) => request<SmartCollectionView>('/api/tunarr/smart-collections/create', jsonBody('POST', body)),
  updateSmartCollection: (id: string, body: { name?: string; keywords?: string } & Partial<RuleSet>) => request<SmartCollectionView>(`/api/tunarr/smart-collections/${encodeURIComponent(id)}`, jsonBody('PUT', body)),
  deleteSmartCollection: (id: string) => request<unknown>(`/api/tunarr/smart-collections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewSmartCollection: (body: { keywords?: string } & RuleSet) =>
    request<{ totalHits: number; sample: Array<{ id?: string; title: string; type?: string; year?: number }> }>('/api/tunarr/smart-collections/preview', jsonBody('POST', body)),
  fillerRoles: () => request<FillerRoles>('/api/tunarr/filler-roles'),
  /** Lists built from folders, folders waiting for their first scan, and libraries not to pick up again. */
  fillerFolders: () => request<FillerFolders>('/api/tunarr/filler-folders'),
  /** Adds a folder on the Tunarr server with a role; its list is made after Tunarr's first scan. */
  addFillerFolder: (path: string, role: FillerRole) => request<{ mediaSourceId: string; libraryId: string; name: string }>('/api/tunarr/filler-folders/add', jsonBody('POST', { path, role })),
  /** Creates (name) or refreshes (listId) a filler list from everything Tunarr indexed in one folder. */
  fillerListFromLibrary: (body: { mediaSourceId: string; libraryId: string; name?: string; listId?: string; role?: FillerRole }) =>
    request<{ id: string; count: number; storeError?: string }>('/api/tunarr/filler-lists/from-library', jsonBody('POST', body)),
  mediaFolder: () => request<MediaFolderStatus>('/api/tunarr/media-folder'),
  /** Adds the upload folder to Tunarr and refreshes or makes folder-built filler lists (server/lineupRoutes.ts). */
  syncFillerFolders: () => request<FillerSync>('/api/tunarr/filler-folders/sync', jsonBody('POST', {})),
  moveMediaFile: (role: FillerRole, name: string, to: FillerRole) => request<unknown>(`${mediaPath(role, name)}/move`, jsonBody('POST', { role: to })),
  deleteMediaFile: (role: FillerRole, name: string) => request<unknown>(mediaPath(role, name), { method: 'DELETE' }),
  setFillerRole: (listId: string, role: FillerRole | null) => request<FillerRoles>(`/api/tunarr/filler-roles/${encodeURIComponent(listId)}`, role ? jsonBody('PUT', { role }) : { method: 'DELETE' }),
  /** Station IDs picked one by one for each channel (server/stationIdStore.ts). */
  stationIdPicks: () => request<StationIdPicks>('/api/tunarr/station-ids'),
  setStationIdPicks: (channelId: string, programIds: string[]) => request<StationIdPicks>(`/api/tunarr/station-ids/${encodeURIComponent(channelId)}`, jsonBody('PUT', { programIds })),
  /** The settings the desk may change, and whether the others are set (server/settings.ts). */
  settings: () => request<SettingsView>('/api/tunarr/server-settings'),
  /** `null` goes back to the .env value. */
  saveSettings: (values: Record<string, number | boolean | string | null>) => request<SettingsView>('/api/tunarr/server-settings', jsonBody('PUT', { values })),
  savedTemplates: () => request<Template[]>('/api/tunarr/templates'),
  createTemplate: (template: Omit<Template, 'id'> & { id?: string }) => request<Template>('/api/tunarr/templates', jsonBody('POST', template)),
  updateTemplate: (id: string, template: Template) => request<Template>(`/api/tunarr/templates/${encodeURIComponent(id)}`, jsonBody('PUT', template)),
  deleteTemplate: (id: string) => request<unknown>(`/api/tunarr/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiStatus: () => request<AiStatus>('/api/tunarr/ai'),
  aiTemplate: (body: { prompt: string; channelId?: string; includeLibrary: boolean; baseTemplate?: Template }) => request<AiProposal>('/api/tunarr/ai/template', jsonBody('POST', body)),
  guide: (from: Date, to: Date) => request<{ from: string; to: string; channels: GuideChannel[] }>(`/api/tunarr/guide?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`),
  sessions: () => request<ViewerCounts>('/api/tunarr/sessions'),
  redirects: () => request<{ edges: Array<{ from: string; to: string }> }>('/api/tunarr/redirects'),
  snapshots: (id: string) => request<SnapshotSummary[]>(`${channelPath(id)}/snapshots`),
  snapshot: (id: string, snapshotId: string) => request<Snapshot>(`${channelPath(id)}/snapshots/${encodeURIComponent(snapshotId)}`),
  takeSnapshot: (id: string) => request<SnapshotSummary | { unchanged: true; message: string }>(`${channelPath(id)}/snapshots`, jsonBody('POST', {})),
  deleteSnapshot: (id: string, snapshotId: string) => request<unknown>(`${channelPath(id)}/snapshots/${encodeURIComponent(snapshotId)}`, { method: 'DELETE' }),
  scheduled: () => request<ScheduledList>('/api/tunarr/scheduled'),
  schedulePlan: (group: 'save' | 'event' | 'overlay', changes: PlannedChange[]) => request<ChangeSummary[]>('/api/tunarr/scheduled', jsonBody('POST', { group, changes })),
  cancelScheduled: (id: string) => request<unknown>(`/api/tunarr/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiReview: (body: { channelName: string; summary: string; issues: string[] }) => request<Review>('/api/tunarr/ai/review', jsonBody('POST', body)),
  lineup: (id: string, from: Date, to: Date) =>
    request<ChannelLineup>(`${channelPath(id)}/lineup?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`),
};
