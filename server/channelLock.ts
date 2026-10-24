// Writes to one channel are serialized within this process, so a version
// check and the write after it can't interleave with another Lineup save:
// a browser session, the scheduler, or a copy from another channel.
const channelLocks = new Map<string, Promise<unknown>>();
// Bumped when a write starts and when it ends, so a cached read of the
// channel (server/programmingCache.ts) made around a write is never reused.
const generations = new Map<string, number>();

export const channelGeneration = (channelId: string) => generations.get(channelId) ?? 0;
/** True while a write to the channel is queued or running. */
export const channelBusy = (channelId: string) => channelLocks.has(channelId);
const bump = (channelId: string) => generations.set(channelId, channelGeneration(channelId) + 1);

export async function withChannelLock<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const write = async () => {
    bump(channelId);
    try {
      return await task();
    } finally {
      bump(channelId);
    }
  };
  const previous = channelLocks.get(channelId) ?? Promise.resolve();
  const run = previous.then(write, write);
  const settled = run.then(() => undefined, () => undefined);
  channelLocks.set(channelId, settled);
  try {
    return await run;
  } finally {
    if (channelLocks.get(channelId) === settled) channelLocks.delete(channelId);
  }
}
