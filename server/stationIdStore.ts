// The station IDs picked one by one for each channel (Channel Settings →
// Commercials), kept by the companion in LINEUP_DATA_DIR/station-ids.json
// (owner decision 2026-10-19). Tunarr has no such field, and putting a single
// clip in a channel's filler would make Tunarr air it in flex time as well.
import { createJsonFile, StoreError } from './jsonFile.js';

export const MAX_PICKS_PER_CHANNEL = 200;
export const MAX_PICKED_CHANNELS = 500;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROGRAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Channel id → the station-ID program ids picked for it. */
export type StationIdPicks = Record<string, string[]>;

export function validatePicks(body: unknown): { programIds: string[] } | { error: string } {
  const ids = body && typeof body === 'object' && !Array.isArray(body) ? (body as { programIds?: unknown }).programIds : undefined;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !PROGRAM_ID.test(id))) return { error: 'Send { "programIds": [...] } with program ids.' };
  const unique = [...new Set(ids.map((id: string) => id.toLowerCase()))];
  if (unique.length > MAX_PICKS_PER_CHANNEL) return { error: `A channel can have up to ${MAX_PICKS_PER_CHANNEL} station IDs picked.` };
  return { programIds: unique };
}

export type StationIdStore = {
  readonly location: string;
  list(): Promise<StationIdPicks>;
  /** An empty list drops the channel. */
  set(channelId: string, programIds: string[]): Promise<StationIdPicks>;
  /** A reset channel gets a new id; its picks follow it. */
  moveChannel(from: string, to: string): Promise<void>;
};

export function createStationIdStore(dir: string): StationIdStore {
  const file = createJsonFile(dir, 'station-ids.json', 'picked station IDs');
  async function read(): Promise<StationIdPicks> {
    const data = (await file.read()) as { channels?: unknown } | undefined;
    const out: StationIdPicks = {};
    // Drop anything a hand edit broke rather than failing the whole desk.
    if (data?.channels && typeof data.channels === 'object' && !Array.isArray(data.channels)) {
      for (const [channel, ids] of Object.entries(data.channels)) {
        if (!CHANNEL_ID.test(channel) || !Array.isArray(ids)) continue;
        const valid = ids.filter((id): id is string => typeof id === 'string' && PROGRAM_ID.test(id)).slice(0, MAX_PICKS_PER_CHANNEL);
        if (valid.length) out[channel] = valid;
      }
    }
    return out;
  }
  return {
    location: file.location,
    list: () => file.serialize(read),
    set: (channelId, programIds) => file.serialize(async () => {
      const picks = await read();
      if (!(channelId in picks) && programIds.length && Object.keys(picks).length >= MAX_PICKED_CHANNELS) throw new StoreError(409, 'too_many_channels', `Station IDs can be picked for up to ${MAX_PICKED_CHANNELS} channels.`);
      if (programIds.length) picks[channelId] = programIds;
      else delete picks[channelId];
      await file.write({ version: 1, channels: picks });
      return picks;
    }),
    moveChannel: (from, to) => file.serialize(async () => {
      const picks = await read();
      if (!picks[from]) return;
      picks[to] = picks[from];
      delete picks[from];
      await file.write({ version: 1, channels: picks });
    }),
  };
}
