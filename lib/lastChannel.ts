// Which channel the desk opens on: one named in the address (?channel=<id>),
// else the one last opened in this browser, else the first. Ids are only
// checked for shape here; the caller confirms the channel exists before using it.

export const LAST_CHANNEL_KEY = 'tunarr-lineup-last-channel';
export const CHANNEL_PARAM = 'channel';
// The companion's own channel-id rule (server/tunarrProxy.ts CHANNEL_ID).
const CHANNEL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const isChannelId = (value: unknown): value is string => typeof value === 'string' && CHANNEL_ID.test(value);

/** The `channel` parameter of a query string, when it's a well-formed id; `invalid` when present but not. */
export function channelFromQuery(search: string): string | { invalid: true } | null {
  const value = new URLSearchParams(search).get(CHANNEL_PARAM);
  if (value === null || value === '') return null;
  return isChannelId(value) ? value : { invalid: true };
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;

/** The channel last opened in this browser; storage that's missing or throws (private mode) means none. */
export function readLastChannel(storage: Storage | undefined): string | null {
  try {
    const value = storage?.getItem(LAST_CHANNEL_KEY);
    return isChannelId(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeLastChannel(storage: Storage | undefined, channelId: string) {
  try {
    if (isChannelId(channelId)) storage?.setItem(LAST_CHANNEL_KEY, channelId);
  } catch {
    // A convenience only: without storage the desk opens on the first channel.
  }
}

/**
 * The channel to open from `channels`, and a note when the address named one
 * this server doesn't have (it is never trusted beyond being in the list).
 */
export function pickChannel<T extends { id: string; name: string }>(channels: T[], options: { preferred?: string; fromQuery?: string | { invalid: true } | null; remembered?: string | null }): { channel: T | undefined; note: string } {
  const byId = (id: string | null | undefined) => (id ? channels.find((channel) => channel.id === id) : undefined);
  const preferred = byId(options.preferred);
  const linked = typeof options.fromQuery === 'string' ? byId(options.fromQuery) : undefined;
  const channel = preferred ?? linked ?? byId(options.remembered) ?? channels[0];
  const missing = !!options.fromQuery && !linked && !preferred;
  return { channel, note: missing && channel ? `The channel in this address isn’t on this Tunarr server, so ${channel.name} opened instead.` : '' };
}

/** The current address with `?channel=` set to `channelId`, keeping the path (sub-path installs) and other parameters. */
export function addressWithChannel(href: string, channelId: string) {
  const url = new URL(href);
  url.searchParams.set(CHANNEL_PARAM, channelId);
  return `${url.pathname}${url.search}${url.hash}`;
}
