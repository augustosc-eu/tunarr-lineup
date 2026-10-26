// The record of batch operations (roadmap milestone 3), in
// LINEUP_DATA_DIR/batches.json: what each one changed on which channel, with
// the values it replaced (channel settings) or the snapshot taken first
// (programming), so it can be audited and rolled back channel by channel.
// It holds channel names, numbers and the allowlisted settings a batch
// touches, never addresses, keys or Tunarr's own replies.
import { randomUUID } from 'node:crypto';
import { createJsonFile } from './jsonFile.js';

export const MAX_BATCHES_KEPT = 30;
const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isBatchId = (value: string) => BATCH_ID.test(value);

export type BatchOperation = 'filler' | 'group' | 'transcode' | 'renumber' | 'settings' | 'repair' | 'import';
export type ChannelOutcome = 'pending' | 'done' | 'unchanged' | 'conflict' | 'blocked' | 'failed' | 'skipped';

export type BatchChannel = {
  channelId: string;
  number: number;
  name: string;
  status: ChannelOutcome;
  message: string;
  /** Settings batches: the touched fields as they were, and the fingerprint they had after the change. */
  before?: Record<string, unknown>;
  afterVersion?: string;
  /** Programming batches: the snapshot taken first, and the version the save left. */
  snapshotId?: string;
  appliedVersion?: string;
  rollback?: { status: 'done' | 'conflict' | 'failed' | 'skipped'; message: string; at: number };
};

export type BatchRecord = {
  id: string;
  operation: BatchOperation;
  label: string;
  createdAt: number;
  finishedAt?: number;
  /** Settings batches: which channel fields it changes. */
  fields: string[];
  channels: BatchChannel[];
};

export type BatchSummary = Omit<BatchRecord, 'channels'> & { counts: Partial<Record<ChannelOutcome, number>>; rolledBack: number };

export function summarizeBatch(record: BatchRecord): BatchSummary {
  const counts: Partial<Record<ChannelOutcome, number>> = {};
  for (const channel of record.channels) counts[channel.status] = (counts[channel.status] ?? 0) + 1;
  const { channels, ...rest } = record;
  return { ...rest, counts, rolledBack: channels.filter((channel) => channel.rollback?.status === 'done').length };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const isRecord = (value: unknown): value is BatchRecord => isObject(value) && typeof value.id === 'string' && typeof value.operation === 'string' && Array.isArray(value.channels);

export type BatchStore = {
  list(): Promise<BatchRecord[]>;
  get(id: string): Promise<BatchRecord | undefined>;
  create(record: Omit<BatchRecord, 'id' | 'createdAt'>): Promise<BatchRecord>;
  /** Applies `change` to one record and saves it. */
  update(id: string, change: (record: BatchRecord) => void): Promise<BatchRecord | undefined>;
};

/**
 * `running` says which batches this process is still applying; any other
 * batch without a finish time was cut short (the server stopped), and its
 * pending channels are reported as skipped rather than left "pending".
 */
export function createBatchStore(dataDir: string, running: () => Set<string>): BatchStore {
  const file = createJsonFile(dataDir, 'batches.json', 'batch operations');
  const read = async (): Promise<BatchRecord[]> => {
    const data = await file.read();
    const records = (isObject(data) && Array.isArray(data.batches) ? data.batches : []).filter(isRecord);
    const live = running();
    for (const record of records) {
      if (record.finishedAt || live.has(record.id)) continue;
      record.finishedAt = record.createdAt;
      for (const channel of record.channels) if (channel.status === 'pending') Object.assign(channel, { status: 'skipped', message: 'Not applied: the Lineup server stopped during the batch.' });
    }
    return records;
  };
  const write = (records: BatchRecord[]) => file.write({ version: 1, batches: records.sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_BATCHES_KEPT) });
  return {
    list: () => file.serialize(read),
    get: (id) => file.serialize(async () => (await read()).find((record) => record.id === id)),
    create: (input) => file.serialize(async () => {
      const records = await read();
      const record: BatchRecord = { ...input, id: randomUUID(), createdAt: Date.now() };
      await write([record, ...records]);
      return record;
    }),
    update: (id, change) => file.serialize(async () => {
      const records = await read();
      const record = records.find((item) => item.id === id);
      if (!record) return undefined;
      change(record);
      await write(records);
      return record;
    }),
  };
}
