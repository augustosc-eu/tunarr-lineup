// Writes to one channel are serialized within this process, so a version
// check and the write after it can't interleave with another Lineup save:
// a browser session, the scheduler, or a copy from another channel.
const channelLocks = new Map<string, Promise<unknown>>();

export async function withChannelLock<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const previous = channelLocks.get(channelId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(() => undefined, () => undefined);
  channelLocks.set(channelId, settled);
  try {
    return await run;
  } finally {
    if (channelLocks.get(channelId) === settled) channelLocks.delete(channelId);
  }
}
