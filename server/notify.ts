// Operational notifications (roadmap milestone 7, D68): a small JSON message
// to one webhook the owner configured, when something happened that someone
// should know about with nobody at the desk. Off unless an address is set.
//
// The address is the one outbound request the owner chooses, so it gets the
// same guards as public logos, stricter: HTTPS only, every address the host
// resolves to must be public (pinned to the connection), no redirects, a time
// limit, a size limit on the reply, and at most two retries. One deliberate
// exception, ticked by the owner: a private-network address (a local ntfy or
// Home Assistant), where plain HTTP and other ports are allowed too, but only
// when every address the host resolves to is private (a public destination is
// always HTTPS on 443, and a name resolving to public and private addresses at
// once is refused); loopback, link-local (cloud metadata) and multicast stay
// refused even then.
//
// Messages carry Lineup's own words and counts. Channel and program names only
// go out when the owner opts in; Tunarr's replies, addresses, IPs, user agents
// and error texts never do (an upstream error message names Tunarr's host).
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { isPublicAddress } from './logos.js';

export const NOTIFY_EVENTS = ['scheduled.applied', 'scheduled.skipped', 'scheduled.failed', 'scheduled.missed', 'save.conflict', 'channel.unhealthy', 'guide.failed', 'media.missing', 'batch.partial'] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number] | 'test';
export const EVENT_LABELS: Record<NotifyEvent, string> = {
  'scheduled.applied': 'A scheduled change went in',
  'scheduled.skipped': 'A scheduled change was skipped',
  'scheduled.failed': 'A scheduled change failed',
  'scheduled.missed': 'A scheduled change was missed',
  'save.conflict': 'A save was refused (the channel had changed)',
  'channel.unhealthy': 'A Control Room check found errors on a channel',
  'guide.failed': 'Tunarr’s guide couldn’t be read',
  'media.missing': 'A channel plays programs Tunarr no longer has',
  'batch.partial': 'A batch finished with conflicts or failures',
  test: 'A test from Server Settings',
};
/** Events sent when the owner turns notifications on without choosing. */
export const DEFAULT_EVENTS: NotifyEvent[] = ['scheduled.skipped', 'scheduled.failed', 'scheduled.missed', 'channel.unhealthy', 'guide.failed', 'batch.partial'];

export const NOTIFY_SCHEMA = 'tunarr-lineup.notification';
export const NOTIFY_VERSION = 1;
const TIMEOUT_MS = 8_000;
const MAX_REPLY_BYTES = 4096;
const RETRY_DELAYS_MS = [2_000, 10_000];
const MAX_QUEUE = 50;
const KEEP_RECENT = 20;

// --------------------------------------------------------------- addresses

/** Private networks the owner may allow: RFC 1918, carrier-grade NAT (Tailscale), IPv6 unique-local. */
const privateNets = new BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10]] as const) privateNets.addSubnet(network, prefix, 'ipv4');
privateNets.addSubnet('fc00::', 7, 'ipv6');

const unwrap = (address: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;

export type AddressKind = 'public' | 'private' | 'blocked';

/** Public, a private network the owner may allow, or never (loopback, link-local, multicast, reserved). */
export function addressKind(address: string): AddressKind {
  const plain = unwrap(address);
  if (isPublicAddress(plain)) return 'public';
  const family = isIP(plain);
  const isPrivate = family === 4 ? privateNets.check(plain, 'ipv4') : family === 6 ? privateNets.check(plain, 'ipv6') : false;
  return isPrivate ? 'private' : 'blocked';
}

/** Whether a webhook may connect to `address`: public always; a private network only when allowed. Never loopback, link-local or multicast. */
export function addressAllowed(address: string, allowPrivate: boolean) {
  const kind = addressKind(address);
  return kind === 'public' || (allowPrivate && kind === 'private');
}

/** Plain HTTP or a port other than 443: only a private-network destination may use them, so nothing crosses the Internet unencrypted. */
export const needsPrivateDestination = (url: URL) => url.protocol !== 'https:' || (url.port !== '' && url.port !== '443');

/**
 * Whether a destination whose addresses are `kinds` may be used for `url`:
 * all public (and then HTTPS on 443), or all private (with the owner's
 * option). A mixture is refused either way: which one the connection gets is
 * up to the resolver, so the stricter rule couldn't be promised.
 */
export function destinationAllowed(kinds: AddressKind[], url: URL, allowPrivate: boolean) {
  if (!kinds.length || kinds.includes('blocked')) return false;
  const hasPrivate = kinds.includes('private');
  if (hasPrivate && kinds.includes('public')) return false;
  if (hasPrivate) return allowPrivate;
  return !needsPrivateDestination(url);
}

const LOCAL_NAMES = /(^|\.)(localhost|localdomain|internal|metadata)$/i;

/** The webhook address, checked as far as it can be without DNS (the lookup is checked when sending). */
export function validateWebhookUrl(raw: unknown, allowPrivate: boolean): { url: URL } | { error: string } {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2048) return { error: 'Type the webhook address (https://…).' };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'The webhook address isn’t a valid URL.' };
  }
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return { error: allowPrivate ? 'Use http:// or https://.' : 'Use an https:// address (or allow a private network address for a local service).' };
  if (url.username || url.password) return { error: 'Put credentials in the address’s path or query, as the service says, not before the host.' };
  if (url.hash) return { error: 'The webhook address can’t have a #fragment.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) ? !addressAllowed(host, allowPrivate) : LOCAL_NAMES.test(host)) return { error: allowPrivate ? 'That address is loopback, link-local or otherwise not allowed.' : 'That address isn’t public. Tick “private network address” for a service on your network.' };
  if (needsPrivateDestination(url)) {
    if (!allowPrivate || (isIP(host) && addressKind(host) === 'public')) return { error: 'A public webhook uses https:// on the standard port (443). Plain http:// and other ports are only for a private network address.' };
    // A name is checked when sending: it must resolve to private addresses only.
  }
  return { url };
}

/** What Server Settings shows of the address: the host only (paths and queries often hold tokens). */
export const shownWebhook = (raw: string | undefined) => {
  try {
    return raw ? new URL(raw).host : '';
  } catch {
    return '';
  }
};

// -------------------------------------------------------------- the message

export type Notice = {
  event: NotifyEvent;
  severity: 'info' | 'warning' | 'error';
  /** Lineup's words, without names. */
  summary: string;
  /** The same with channel and program names, sent only when the owner opts in. */
  named?: string;
  channel?: { id: string; number?: number; name?: string };
  counts?: Record<string, number>;
  /** A repeat of the same key within this long isn't sent again. */
  dedupe?: { key: string; ms: number };
};

export type Payload = {
  schema: typeof NOTIFY_SCHEMA;
  version: typeof NOTIFY_VERSION;
  id: string;
  event: NotifyEvent;
  severity: Notice['severity'];
  at: string;
  summary: string;
  channel?: { id: string; number?: number; name?: string };
  counts?: Record<string, number>;
};

export function buildPayload(notice: Notice, includeNames: boolean, now = Date.now(), id: string = randomUUID()): Payload {
  const channel = notice.channel ? { id: notice.channel.id, ...(notice.channel.number !== undefined ? { number: notice.channel.number } : {}), ...(includeNames && notice.channel.name ? { name: notice.channel.name.slice(0, 120) } : {}) } : undefined;
  return {
    schema: NOTIFY_SCHEMA, version: NOTIFY_VERSION, id, event: notice.event, severity: notice.severity, at: new Date(now).toISOString(),
    summary: (includeNames && notice.named ? notice.named : notice.summary).slice(0, 500),
    ...(channel ? { channel } : {}),
    ...(notice.counts ? { counts: notice.counts } : {}),
  };
}

// ---------------------------------------------------------------- delivery

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void;
export type LookupImpl = (hostname: string, options: { all: true }, callback: (error: NodeJS.ErrnoException | null, addresses: Array<{ address: string; family: number }>) => void) => void;

export type DeliveryOptions = { allowPrivate: boolean; timeoutMs?: number; lookupImpl?: LookupImpl; classify?: (address: string) => AddressKind };

/**
 * POSTs `body` once. Resolves with the reply status; rejects on a refused
 * address, a redirect, a timeout or a network error. The reply is read up to
 * MAX_REPLY_BYTES and otherwise ignored.
 */
export function postWebhook(url: URL, body: string, options: DeliveryOptions): Promise<{ status: number }> {
  const classify = options.classify ?? addressKind;
  const allowed = (addresses: string[]) => destinationAllowed(addresses.map(classify), url, options.allowPrivate);
  const resolver: LookupImpl = options.lookupImpl ?? ((hostname, opts, callback) => lookup(hostname, opts, callback));
  return new Promise((resolve, reject) => {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !allowed([host])) return reject(Object.assign(new Error('The webhook address isn’t allowed.'), { code: 'EBLOCKED' }));
    // Every address the name resolves to must be allowed (all public, or all private for http:// and other ports),
    // and the connection uses one of them (no rebinding in between).
    const pinned = (hostname: string, lookupOptions: { all?: boolean }, callback: LookupCallback) => {
      resolver(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, '');
        if (!addresses.length || !allowed(addresses.map((entry) => entry.address))) return callback(Object.assign(new Error('The webhook host resolves to an address that isn’t allowed.'), { code: 'EBLOCKED' }), '');
        if (lookupOptions.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      });
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'POST', lookup: pinned as never, timeout: options.timeoutMs ?? TIMEOUT_MS,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'TunarrLineup/1', accept: '*/*' },
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        return reject(Object.assign(new Error('The webhook answered with a redirect, which isn’t followed.'), { code: 'EREDIRECT' }));
      }
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REPLY_BYTES) response.destroy();
      });
      response.on('close', () => resolve({ status }));
      response.on('error', () => resolve({ status }));
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('The webhook didn’t answer in time.'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end(body);
  });
}

/** Lineup's words for a failed delivery: never the address. */
function deliveryError(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  if (code === 'EBLOCKED') return 'The address (or what it resolves to) isn’t allowed.';
  if (code === 'EREDIRECT') return 'The webhook answered with a redirect, which isn’t followed.';
  if (code === 'ETIMEDOUT') return 'The webhook didn’t answer in time.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The webhook’s host name didn’t resolve.';
  return 'The webhook couldn’t be reached.';
}

// --------------------------------------------------------------- notifier

export type Delivery = { event: NotifyEvent; at: number; ok: boolean; status?: number; error?: string; attempts: number };

export type NotifySettings = { url: URL; events: Set<NotifyEvent>; includeNames: boolean; allowPrivate: boolean };

export type Notifier = {
  readonly settings: NotifySettings | null;
  /** Why it's off when an address is set but unusable (shown in Server Settings). */
  readonly problem?: string;
  /** Queues a notice if its event is on (never throws, never waits). */
  notify(notice: Notice): void;
  /** Sends a test now and says how it went. */
  test(): Promise<Delivery>;
  recent(): Delivery[];
  /** Resolves when the queue is empty (tests). */
  idle(): Promise<void>;
};

export type NotifierHooks = { send?: (url: URL, body: string) => Promise<{ status: number }>; sleep?: (ms: number) => Promise<void>; now?: () => number };

/** The notification settings from config.json's keys (LINEUP_NOTIFY_*). */
export function readNotifySettings(env: Record<string, string | undefined>): { settings: NotifySettings | null; problem?: string } {
  const raw = env.LINEUP_NOTIFY_URL?.trim();
  if (!raw) return { settings: null };
  const allowPrivate = env.LINEUP_NOTIFY_PRIVATE === 'on';
  const checked = validateWebhookUrl(raw, allowPrivate);
  if ('error' in checked) return { settings: null, problem: checked.error };
  const chosen = (env.LINEUP_NOTIFY_EVENTS ?? '').split(',').map((item) => item.trim()).filter((item): item is NotifyEvent => (NOTIFY_EVENTS as readonly string[]).includes(item));
  return { settings: { url: checked.url, events: new Set(env.LINEUP_NOTIFY_EVENTS === undefined ? DEFAULT_EVENTS : chosen), includeNames: env.LINEUP_NOTIFY_NAMES === 'on', allowPrivate } };
}

export function createNotifier(env: Record<string, string | undefined>, hooks: NotifierHooks = {}): Notifier {
  const { settings, problem } = readNotifySettings(env);
  const now = hooks.now ?? Date.now;
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const send = hooks.send ?? ((url: URL, body: string) => postWebhook(url, body, { allowPrivate: settings?.allowPrivate ?? false }));
  const recent: Delivery[] = [];
  const sentAt = new Map<string, number>();
  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;

  async function deliver(notice: Notice): Promise<Delivery> {
    if (!settings) return { event: notice.event, at: now(), ok: false, error: problem ?? 'Notifications are off.', attempts: 0 };
    const body = JSON.stringify(buildPayload(notice, settings.includeNames, now()));
    let attempts = 0;
    let last: Delivery = { event: notice.event, at: now(), ok: false, attempts };
    for (;;) {
      attempts += 1;
      try {
        const { status } = await send(settings.url, body);
        last = { event: notice.event, at: now(), ok: status >= 200 && status < 300, status, attempts };
        // Only a busy or failing service is worth asking again.
        if (last.ok || (status !== 429 && status < 500)) break;
      } catch (error) {
        last = { event: notice.event, at: now(), ok: false, error: deliveryError(error), attempts };
        // A refused address, a redirect or a name that doesn't exist won't change on a retry.
        if (['EBLOCKED', 'EREDIRECT', 'ENOTFOUND'].includes(String((error as { code?: unknown })?.code))) break;
      }
      if (attempts > RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempts - 1]);
    }
    recent.unshift(last);
    recent.splice(KEEP_RECENT);
    return last;
  }

  return {
    settings,
    problem,
    notify(notice) {
      if (!settings || notice.event === 'test' || !settings.events.has(notice.event)) return;
      if (notice.dedupe) {
        const last = sentAt.get(notice.dedupe.key);
        if (last !== undefined && now() - last < notice.dedupe.ms) return;
        sentAt.set(notice.dedupe.key, now());
      }
      if (waiting >= MAX_QUEUE) return;
      waiting += 1;
      queue = queue.then(() => deliver(notice)).then(() => undefined, () => undefined).finally(() => { waiting -= 1; });
    },
    test: () => deliver({ event: 'test', severity: 'info', summary: 'A test notification from Tunarr Lineup. Notifications reach this address.' }),
    recent: () => [...recent],
    idle: () => queue,
  };
}
