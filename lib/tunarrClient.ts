// Browser client for the companion's same-origin /api/tunarr routes. It never
// knows or contacts the Tunarr server's own address.
import type { Channel, ChannelLineup, ManualProgrammingRequest, Programming } from './lineup';
import type { RuleSet } from '../server/smartCollection';
import type { Template } from '../server/templateSchema';
import type { ChannelSettings, ContentProgram, ListSummary, ManagedSource, MediaSource, NamedItem, NewMediaSource, SearchResult, SmartCollectionView, TranscodeProfile } from './library';
import type { SchedulePreview, Slot, SlotSchedule } from './schedule';

export type ScheduleDraft = { type: SlotSchedule['type']; settings?: Record<string, unknown>; slots: Slot[]; extraPrograms?: string[] };
export type AiStatus = { enabled: true; provider: string; model: string } | { enabled: false; message: string };
export type AiProposal = { template: Template; lists: { commercials?: string; promos?: string }; notes: string };
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
  savedTemplates: () => request<Template[]>('/api/tunarr/templates'),
  createTemplate: (template: Omit<Template, 'id'> & { id?: string }) => request<Template>('/api/tunarr/templates', jsonBody('POST', template)),
  updateTemplate: (id: string, template: Template) => request<Template>(`/api/tunarr/templates/${encodeURIComponent(id)}`, jsonBody('PUT', template)),
  deleteTemplate: (id: string) => request<unknown>(`/api/tunarr/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  aiStatus: () => request<AiStatus>('/api/tunarr/ai'),
  aiTemplate: (body: { prompt: string; channelId?: string; includeLibrary: boolean; baseTemplate?: Template }) => request<AiProposal>('/api/tunarr/ai/template', jsonBody('POST', body)),
  lineup: (id: string, from: Date, to: Date) =>
    request<ChannelLineup>(`${channelPath(id)}/lineup?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`),
};
