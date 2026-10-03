// Browser client for the companion's same-origin /api/tunarr routes. It never
// knows or contacts the Tunarr server's own address.
import type { Channel, ChannelLineup, ManualProgrammingRequest, Programming } from './lineup';
import type { SchedulePreview, Slot, SlotSchedule } from './schedule';

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
  previewSchedule: (id: string, slots: Slot[]) =>
    request<SchedulePreview>(`${channelPath(id)}/schedule-preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots, timeZoneOffset: new Date().getTimezoneOffset() }),
    }),
  saveSchedule: (id: string, type: SlotSchedule['type'], slots: Slot[], preview: Pick<SchedulePreview, 'seed' | 'discardCount'>, version: string) =>
    request<Programming>(`${channelPath(id)}/programming`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'if-match': `"${version}"` },
      body: JSON.stringify({ type, schedule: { slots, timeZoneOffset: new Date().getTimezoneOffset() }, seed: preview.seed, discardCount: preview.discardCount }),
    }),
  lineup: (id: string, from: Date, to: Date) =>
    request<ChannelLineup>(`${channelPath(id)}/lineup?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`),
};
