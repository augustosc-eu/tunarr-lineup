// Snapshots of a channel's programming, taken by the companion just before
// anything replaces it: a manual or schedule save, a reset, a recreate, a
// scheduled change. One file per channel (LINEUP_DATA_DIR/snapshots/<id>.json),
// newest first, so yesterday's lineup can be brought back after a mistake.
// Restoring never writes to Tunarr by itself: the desk loads a snapshot as an
// edit, and it's saved like any other (conditional) edit.
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createJsonFile, StoreError, type JsonFile } from './jsonFile.js';
import { lineupLength, programmingVersion } from './lineupVersion.js';
import { slimPrograms } from './lineupItems.js';

export const MAX_SNAPSHOTS_PER_CHANNEL = 15;
/** A channel's snapshot file stays under this; the oldest go first. */
export const MAX_SNAPSHOT_FILE_BYTES = 40 * 1024 * 1024;
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type Snapshot = {
  id: string;
  channelId: string;
  takenAt: number;
  reason: string;
  version: string;
  /** The channel had a slot schedule; restoring brings back its lineup only. */
  hadSchedule: boolean;
  lineup: unknown[];
  programs: Record<string, unknown>;
};

export type SnapshotSummary = Omit<Snapshot, 'lineup' | 'programs'> & { items: number; length: number };

export type SnapshotStore = {
  /** Keeps `programming` (Tunarr's reply) unless the newest snapshot is already this version. */
  take(channelId: string, programming: unknown, reason: string): Promise<SnapshotSummary | null>;
  list(channelId: string): Promise<SnapshotSummary[]>;
  get(channelId: string, id: string): Promise<Snapshot | undefined>;
  remove(channelId: string, id: string): Promise<boolean>;
  /** A recreated channel gets a new id; its snapshots follow it. */
  moveChannel(from: string, to: string): Promise<void>;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function summary(snapshot: Snapshot): SnapshotSummary {
  const rest: Partial<Snapshot> = { ...snapshot };
  delete rest.lineup;
  delete rest.programs;
  return { ...(rest as Omit<Snapshot, 'lineup' | 'programs'>), items: snapshot.lineup.length, length: lineupLength(snapshot.lineup) };
}

function isSnapshot(value: unknown): value is Snapshot {
  return isObject(value) && typeof value.id === 'string' && typeof value.channelId === 'string' && typeof value.takenAt === 'number'
    && typeof value.version === 'string' && Array.isArray(value.lineup) && isObject(value.programs);
}

export function createSnapshotStore(dataDir: string): SnapshotStore {
  const dir = path.join(dataDir, 'snapshots');
  const files = new Map<string, JsonFile>();
  const fileFor = (channelId: string) => {
    if (!CHANNEL_ID.test(channelId)) throw new StoreError(400, 'invalid_parameter', 'Channel id is not valid.');
    let file = files.get(channelId);
    if (!file) {
      file = createJsonFile(dir, `${channelId}.json`, 'channel snapshots');
      files.set(channelId, file);
    }
    return file;
  };

  async function read(file: JsonFile): Promise<Snapshot[]> {
    const data = await file.read();
    const items = isObject(data) && Array.isArray(data.snapshots) ? data.snapshots : [];
    return items.filter(isSnapshot);
  }

  async function write(file: JsonFile, snapshots: Snapshot[]) {
    let kept = snapshots.slice(0, MAX_SNAPSHOTS_PER_CHANNEL);
    // Very long lineups: drop the oldest until the file fits (always keep the newest).
    while (kept.length > 1 && JSON.stringify(kept).length > MAX_SNAPSHOT_FILE_BYTES) kept = kept.slice(0, -1);
    if (kept.length) await file.write({ version: 1, snapshots: kept });
    else await file.remove();
  }

  return {
    take(channelId, programming, reason) {
      const file = fileFor(channelId);
      return file.serialize(async () => {
        const current = isObject(programming) ? programming : {};
        const lineup = Array.isArray(current.lineup) ? current.lineup : [];
        const version = programmingVersion(current.lineup, current.schedule);
        const snapshots = await read(file);
        if (snapshots[0]?.version === version) return null;
        // An empty channel has nothing worth bringing back.
        if (!lineup.length) return null;
        const snapshot: Snapshot = {
          id: randomUUID(), channelId, takenAt: Date.now(), reason: reason.slice(0, 200), version,
          hadSchedule: current.schedule != null, lineup, programs: slimPrograms(lineup, current.programs),
        };
        await write(file, [snapshot, ...snapshots]);
        return summary(snapshot);
      });
    },
    list(channelId) {
      const file = fileFor(channelId);
      return file.serialize(async () => (await read(file)).map(summary));
    },
    get(channelId, id) {
      const file = fileFor(channelId);
      return file.serialize(async () => (await read(file)).find((snapshot) => snapshot.id === id));
    },
    remove(channelId, id) {
      const file = fileFor(channelId);
      return file.serialize(async () => {
        const snapshots = await read(file);
        const next = snapshots.filter((snapshot) => snapshot.id !== id);
        if (next.length === snapshots.length) return false;
        await write(file, next);
        return true;
      });
    },
    async moveChannel(from, to) {
      if (from === to) return;
      const source = fileFor(from);
      const target = fileFor(to);
      const moved = await source.serialize(async () => {
        const snapshots = await read(source);
        await source.remove();
        return snapshots;
      });
      if (!moved.length) return;
      await target.serialize(async () => {
        const existing = await read(target);
        const merged = [...existing, ...moved.map((snapshot) => ({ ...snapshot, channelId: to }))].sort((a, b) => b.takenAt - a.takenAt);
        await write(target, merged);
      });
    },
  };
}
