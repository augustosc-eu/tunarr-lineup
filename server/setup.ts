// The setup wizard and the connection part of Setup → Server Settings (owner
// decision 2026-10-25, D62). Until setup is done, every other API route answers
// 503 setup_required, and the wizard's routes need the one-time setup code the
// server prints in its log (or the desktop app hands its window), so nobody else
// on the network can claim an unconfigured server. Afterwards the same values
// are edited by the signed-in user under /server-config. The Tunarr address is
// typed here, but it is only ever used by the companion as its fixed upstream:
// the browser still never contacts Tunarr. Keys and passwords are write-only.
import { randomInt } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createAiConfig } from './ai.js';
import { compatibilitySummary, detectCompatibility } from './compatibility.js';
import { DEFAULT_EVENTS, EVENT_LABELS, NOTIFY_EVENTS, shownWebhook, validateWebhookUrl } from './notify.js';
import { validateAccount, verifyPassword, hashPassword, type AuthConfig } from './auth.js';
import { configEnv, isComplete, type ConfigKey, type ConfigStore, type StoredConfig } from './configStore.js';
import { createMediaFolder } from './mediaFolder.js';
import { applySettings } from './settings.js';
import { parseTunarrUrl, type ProxyConfig, type ProxyResponse, type TunarrTarget } from './tunarrProxy.js';
import { callTunarr, fail, json, UpstreamError } from './upstream.js';

export type SetupRoute = { name: 'status' | 'unlock' | 'detect' | 'test' | 'finish' | 'config' | 'config-detect' | 'config-test' | 'config-notify-test'; methods: string[] };

export function matchSetupRoute(path: string): SetupRoute | null {
  switch (path) {
    case '/setup': return { name: 'status', methods: ['GET'] };
    case '/setup/unlock': return { name: 'unlock', methods: ['POST'] };
    case '/setup/detect': return { name: 'detect', methods: ['POST'] };
    case '/setup/test': return { name: 'test', methods: ['POST'] };
    case '/setup/finish': return { name: 'finish', methods: ['POST'] };
    case '/server-config': return { name: 'config', methods: ['GET', 'PUT'] };
    case '/server-config/detect': return { name: 'config-detect', methods: ['POST'] };
    case '/server-config/test': return { name: 'config-test', methods: ['POST'] };
    case '/server-config/notify-test': return { name: 'config-notify-test', methods: ['POST'] };
    default: return null;
  }
}

// ------------------------------------------------------------------ state

// Unambiguous letters and digits (no 0/O, 1/I/L), shown as XXXXX-XXXXX.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeCode = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
export function newSetupCode() {
  const chars = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const MAX_TRIES = 5;
const LOCK_MS = 60_000;

export type Setup = {
  readonly store: ConfigStore;
  readonly dataDir: string;
  /** The interface's files, which the media folder must stay out of. */
  readonly staticDir?: string;
  /** Shown in the server log until setup is done. */
  readonly code: string;
  stored(): StoredConfig;
  needed(): boolean;
  /** The sign-in the server asks for now: none until there is an account. */
  auth(): AuthConfig;
  /** The environment the rest of the server reads (configEnv). */
  env(): Record<string, string | undefined>;
  checkCode(given: unknown): 'ok' | 'wrong' | 'locked';
  /** Writes config.json, then applies it to the running server. */
  save(config: ProxyConfig, next: StoredConfig): Promise<void>;
};

export function createSetup(options: {
  store: ConfigStore; stored: StoredConfig; processEnv: Record<string, string | undefined>; dataDir: string;
  staticDir?: string; appKey?: string; code?: string; now?: () => number;
}): Setup {
  let current = options.stored;
  const code = options.code && normalizeCode(options.code).length >= 10 ? options.code : newSetupCode();
  const now = options.now ?? Date.now;
  let wrong = 0;
  let lockedUntil = 0;
  return {
    store: options.store,
    dataDir: options.dataDir,
    staticDir: options.staticDir,
    code,
    stored: () => current,
    needed: () => !current.setupComplete,
    auth: () => (current.setupComplete && current.account ? { username: current.account.username, passwordHash: current.account.passwordHash, appKey: options.appKey } : null),
    env: () => configEnv(options.processEnv, current.values),
    checkCode(given) {
      if (now() < lockedUntil) return 'locked';
      const ok = typeof given === 'string' && normalizeCode(given) === normalizeCode(code);
      if (ok) { wrong = 0; return 'ok'; }
      wrong += 1;
      if (wrong >= MAX_TRIES) { wrong = 0; lockedUntil = now() + LOCK_MS; }
      return 'wrong';
    },
    async save(config, next) {
      await options.store.serialize(() => options.store.write(next));
      current = next;
      await applyConfig(config, configEnv(options.processEnv, next.values));
    },
  };
}

/** Points the running server at the configuration: Tunarr, the media folder, AI and the tuning settings. */
export async function applyConfig(config: ProxyConfig, env: Record<string, string | undefined>) {
  const parsed = parseTunarrUrl(env.TUNARR_URL);
  const target = parsed && 'target' in parsed ? parsed.target : null;
  const where = (value: TunarrTarget | null) => (value ? `${value.origin}${value.basePath}` : '');
  if (where(target) !== where(config.target)) config.programmingCache?.clear();
  config.target = target;
  config.configError = parsed && 'error' in parsed ? parsed.error : undefined;
  config.mediaFolder = createMediaFolder(env);
  config.settings?.setEnv(env);
  applySettings(config, env, (await config.settings?.saved()) ?? {});
}

// ------------------------------------------------------------- validation

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const CONTROL = /[\u0000-\u001f\u007f]/;
const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max && !CONTROL.test(value) ? value.trim() : null);
const isFullPath = (value: string) => path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
const inside = (child: string, parent: string) => child === parent || child.startsWith(`${parent}${path.sep}`);

/** The address the browser is shown: credentials are write-only. */
function shownUrl(raw: string | undefined) {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return '';
  }
}

function checkTunarrUrl(raw: unknown): { url: string; target: TunarrTarget } | { error: string } {
  const value = text(raw, 2048);
  if (!value) return { error: 'Type Tunarr’s address, like http://192.168.1.20:8000.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const parsed = parseTunarrUrl(withScheme);
  if (!parsed) return { error: 'Type Tunarr’s address, like http://192.168.1.20:8000.' };
  if ('error' in parsed) return { error: parsed.error.replace('TUNARR_URL', 'The Tunarr address') };
  return { url: withScheme.replace(/\/+$/, ''), target: parsed.target };
}

/**
 * Applies the connection fields of a wizard or settings request to `values`:
 * Tunarr's address, AI, the media folder and two options. A field left out is
 * kept; an empty string clears it; an API key is never sent back, so `apiKey`
 * left out keeps the saved one.
 */
export async function applyConnectionFields(values: StoredConfig['values'], body: Json, where: { dataDir: string; staticDir?: string }): Promise<{ values: StoredConfig['values'] } | { error: string }> {
  const next = { ...values };
  const put = (key: ConfigKey, value: string) => { if (value) next[key] = value; else delete next[key]; };

  if ('tunarrUrl' in body) {
    // The address as shown (without its credentials) keeps the saved one.
    if (!(values.TUNARR_URL && body.tunarrUrl === shownUrl(values.TUNARR_URL))) {
      const checked = checkTunarrUrl(body.tunarrUrl);
      if ('error' in checked) return checked;
      next.TUNARR_URL = checked.url;
    }
  }

  if ('ai' in body) {
    const ai = body.ai;
    if (!isObject(ai)) return { error: 'Send ai as { provider, apiKey?, baseUrl?, model? }.' };
    const provider = ai.provider === '' || ai.provider === undefined ? '' : ai.provider;
    if (provider !== '' && provider !== 'anthropic' && provider !== 'openai') return { error: 'AI provider: anthropic, openai or none.' };
    if (!provider) {
      for (const key of ['LINEUP_AI_PROVIDER', 'LINEUP_AI_API_KEY', 'LINEUP_AI_BASE_URL', 'LINEUP_AI_MODEL'] as const) delete next[key];
    } else {
      put('LINEUP_AI_PROVIDER', provider);
      if ('apiKey' in ai) {
        const key = text(ai.apiKey, 1000);
        if (key === null) return { error: 'AI key: at most 1000 characters, on one line.' };
        put('LINEUP_AI_API_KEY', key);
      }
      for (const [field, key, max] of [['baseUrl', 'LINEUP_AI_BASE_URL', 2048], ['model', 'LINEUP_AI_MODEL', 200]] as const) {
        if (!(field in ai)) continue;
        const value = text(ai[field], max);
        if (value === null) return { error: `AI ${field === 'baseUrl' ? 'address' : 'model'}: at most ${max} characters, on one line.` };
        put(key, value);
      }
      if (next.LINEUP_AI_BASE_URL) {
        try {
          if (!/^https?:$/.test(new URL(next.LINEUP_AI_BASE_URL).protocol)) throw new Error();
        } catch {
          return { error: 'AI address must start with http:// or https://.' };
        }
      }
      if (provider === 'anthropic' && !next.LINEUP_AI_API_KEY) return { error: 'Anthropic needs an API key.' };
      if (provider === 'openai' && !next.LINEUP_AI_MODEL) return { error: 'Type the model to use (for example llama3.1 for Ollama).' };
      if (provider === 'openai' && !next.LINEUP_AI_API_KEY && !next.LINEUP_AI_BASE_URL) return { error: 'OpenAI needs an API key, or type the address of an OpenAI-compatible server such as Ollama.' };
      const built = createAiConfig(next);
      if ('off' in built) return { error: built.off };
    }
  }

  if ('media' in body) {
    const media = body.media;
    if (!isObject(media)) return { error: 'Send media as { dir, tunarrDir? }.' };
    const dir = text(media.dir ?? '', 1024);
    const tunarrDir = text(media.tunarrDir ?? '', 1024);
    if (dir === null || tunarrDir === null) return { error: 'Folder paths: at most 1024 characters, on one line.' };
    if (!dir) {
      delete next.LINEUP_MEDIA_DIR;
      delete next.LINEUP_MEDIA_TUNARR_DIR;
    } else {
      if (!path.isAbsolute(dir)) return { error: 'Media folder: a full path, like /media/lineup.' };
      const resolved = path.resolve(dir);
      const isDir = await stat(resolved).then((info) => info.isDirectory(), () => false);
      if (!isDir) return { error: `There is no folder at ${resolved.slice(0, 200)} on the Lineup server. Create it (or mount it), then try again.` };
      // Uploads and deletes stay out of Lineup's own data and the interface's files,
      // compared by real path so a link can't lead there.
      const real = await realpath(resolved);
      for (const own of [where.dataDir, where.staticDir]) {
        if (!own) continue;
        const ownReal = await realpath(own).catch(() => path.resolve(own));
        if (inside(real, ownReal) || inside(ownReal, real)) return { error: 'The media folder can’t be, or hold, Lineup’s own data or interface folder.' };
      }
      next.LINEUP_MEDIA_DIR = resolved;
      if (tunarrDir && !isFullPath(tunarrDir)) return { error: 'Media folder as Tunarr sees it: a full path, like /media/lineup.' };
      put('LINEUP_MEDIA_TUNARR_DIR', tunarrDir);
    }
  }

  if ('notifications' in body) {
    const notifications = body.notifications;
    if (!isObject(notifications)) return { error: 'Send notifications as { url?, events?, includeNames?, allowPrivate? }.' };
    const allowPrivate = 'allowPrivate' in notifications ? notifications.allowPrivate === true : next.LINEUP_NOTIFY_PRIVATE === 'on';
    if ('allowPrivate' in notifications) next.LINEUP_NOTIFY_PRIVATE = allowPrivate ? 'on' : 'off';
    // The address is write-only: left out keeps the saved one (checked again against the private-network choice); empty turns notifications off.
    const raw = 'url' in notifications ? text(notifications.url ?? '', 2048) : next.LINEUP_NOTIFY_URL ?? '';
    if (raw === null) return { error: 'The webhook address is up to 2048 characters, on one line.' };
    if (!raw) delete next.LINEUP_NOTIFY_URL;
    else {
      const checked = validateWebhookUrl(raw, allowPrivate);
      if ('error' in checked) return { error: `Webhook: ${checked.error}` };
      next.LINEUP_NOTIFY_URL = checked.url.href;
    }
    if ('events' in notifications) {
      const events = notifications.events;
      if (!Array.isArray(events) || events.some((event) => !(NOTIFY_EVENTS as readonly unknown[]).includes(event))) return { error: 'Choose events from the list.' };
      next.LINEUP_NOTIFY_EVENTS = [...new Set(events as string[])].join(',');
    }
    if ('includeNames' in notifications) next.LINEUP_NOTIFY_NAMES = notifications.includeNames === true ? 'on' : 'off';
  }

  if ('options' in body) {
    const options = body.options;
    if (!isObject(options)) return { error: 'Send options as { scheduler?, externalLogos? }.' };
    if ('scheduler' in options) {
      if (typeof options.scheduler !== 'boolean') return { error: 'Scheduled changes: true or false.' };
      next.LINEUP_SCHEDULER = options.scheduler ? 'on' : 'off';
    }
    if ('externalLogos' in options) {
      if (typeof options.externalLogos !== 'boolean') return { error: 'Public logos: true or false.' };
      next.LINEUP_EXTERNAL_LOGOS = options.externalLogos ? 'true' : 'false';
    }
  }
  return { values: next };
}

// --------------------------------------------------------------- detection

/** The default gateway from /proc/net/route: in a container, usually the Docker host. */
async function dockerGateway() {
  try {
    const table = await readFile('/proc/net/route', 'utf8');
    for (const line of table.split('\n').slice(1)) {
      const [, destination, gateway] = line.trim().split(/\s+/);
      if (destination !== '00000000' || !gateway || !/^[0-9A-F]{8}$/i.test(gateway)) continue;
      const bytes = gateway.match(/../g)!.map((pair) => parseInt(pair, 16)).reverse();
      return bytes.join('.');
    }
  } catch {
    // Not Linux, or not allowed to read it.
  }
  return null;
}

/** Fixed places Tunarr usually is, from where Lineup runs (decided: no network scan). */
export async function detectCandidates() {
  const places = ['http://localhost:8000', 'http://tunarr:8000', 'http://host.docker.internal:8000'];
  const gateway = await dockerGateway();
  if (gateway && gateway !== '0.0.0.0') places.push(`http://${gateway}:8000`);
  return places;
}

export type Probe =
  | { url: string; host: string; ok: true; channelCount: number; compatibility?: CompatibilitySummary }
  | { url: string; host: string; ok: false; message: string };

/** Asks one address for its channel list, the same way the health check does. */
export async function probeTunarr(config: ProxyConfig, url: string, target: TunarrTarget, timeoutMs = 3000): Promise<Probe> {
  try {
    const channels = await callTunarr({ ...config, timeoutMs }, target, 'GET', '/api/channels');
    if (!Array.isArray(channels)) return { url: shownUrl(url), host: target.host, ok: false, message: `${target.host} answered, but not like Tunarr.` };
    return { url: shownUrl(url), host: target.host, ok: true, channelCount: channels.length };
  } catch (error) {
    const message = error instanceof UpstreamError ? error.message.replace('Check TUNARR_URL.', 'Check the address.') : `Could not reach ${target.host}.`;
    return { url: shownUrl(url), host: target.host, ok: false, message };
  }
}

async function detect(config: ProxyConfig) {
  const places = await detectCandidates();
  const probes = await Promise.all(places.map((url) => {
    const parsed = parseTunarrUrl(url);
    return parsed && 'target' in parsed ? probeTunarr(config, url, parsed.target) : null;
  }));
  const tried = probes.filter((probe): probe is Probe => !!probe);
  return { found: tried.filter((probe) => probe.ok), tried: tried.map((probe) => probe.host) };
}

// ------------------------------------------------------------------ routes

/** What the wizard and Server Settings show: never a key, a password, Tunarr's credentials or the webhook's path. */
function configView(setup: Setup, config?: ProxyConfig) {
  const { values, account } = setup.stored();
  return {
    notifications: {
      set: !!values.LINEUP_NOTIFY_URL,
      host: shownWebhook(values.LINEUP_NOTIFY_URL),
      events: values.LINEUP_NOTIFY_EVENTS === undefined ? DEFAULT_EVENTS : values.LINEUP_NOTIFY_EVENTS.split(',').filter(Boolean),
      includeNames: values.LINEUP_NOTIFY_NAMES === 'on',
      allowPrivate: values.LINEUP_NOTIFY_PRIVATE === 'on',
      problem: config?.notifier?.problem ?? null,
      recent: config?.notifier?.recent() ?? [],
      catalog: NOTIFY_EVENTS.map((id) => ({ id, label: EVENT_LABELS[id] })),
    },
    tunarr: { url: shownUrl(values.TUNARR_URL), credentials: /^[a-z]+:\/\/[^/]*@/i.test(values.TUNARR_URL ?? '') },
    account: { username: account?.username ?? '' },
    ai: { provider: values.LINEUP_AI_PROVIDER ?? '', model: values.LINEUP_AI_MODEL ?? '', baseUrl: values.LINEUP_AI_BASE_URL ?? '', keySet: !!values.LINEUP_AI_API_KEY },
    media: { dir: values.LINEUP_MEDIA_DIR ?? '', tunarrDir: values.LINEUP_MEDIA_TUNARR_DIR ?? '' },
    options: { scheduler: ['on', 'true', '1'].includes(values.LINEUP_SCHEDULER?.toLowerCase() ?? ''), externalLogos: values.LINEUP_EXTERNAL_LOGOS?.toLowerCase() !== 'false' },
    location: setup.store.location,
  };
}

export type ConfigView = ReturnType<typeof configView>;
export type CompatibilitySummary = ReturnType<typeof compatibilitySummary>;

const CODE_HELP = 'The setup code is printed in the Lineup server’s log (docker logs tunarr-lineup, or the terminal it runs in).';

export async function handleSetupRoute(route: SetupRoute, { config, method, body }: { config: ProxyConfig; method: string; body: unknown }): Promise<ProxyResponse> {
  const setup = config.setup;
  if (!setup) return fail(503, 'setup_off', 'This server is configured where it runs, not from the desk.');
  const input = isObject(body) ? body : {};
  const where = { dataDir: setup.dataDir, staticDir: setup.staticDir };

  if (route.name === 'status') return json(200, { needed: setup.needed() });
  // Before there is an account nobody is signed in, so only the code-checked routes answer.
  if (route.name.startsWith('config') && setup.needed()) return setupRequired(false);

  if (route.name === 'unlock' || route.name === 'detect' || route.name === 'test' || route.name === 'finish') {
    if (!setup.needed()) return fail(409, 'already_set_up', 'Lineup is already set up. Change its settings under Setup → Server Settings.');
    const checked = setup.checkCode(input.code);
    if (checked === 'locked') return fail(429, 'setup_locked', 'Too many wrong setup codes. Wait a minute, then try again.');
    if (checked === 'wrong') return fail(403, 'wrong_setup_code', `That isn’t the setup code. ${CODE_HELP}`);
  }

  switch (route.name) {
    case 'unlock': return json(200, configView(setup));
    case 'detect':
    case 'config-detect': return json(200, await detect(config));
    case 'config-notify-test': {
      if (!config.notifier?.settings) return fail(409, 'notifications_off', config.notifier?.problem ?? 'Set a webhook address and save it first.');
      return json(200, await config.notifier.test());
    }
    case 'test':
    case 'config-test': {
      // The shown address (no credentials) tests the saved one.
      const saved = setup.stored().values.TUNARR_URL;
      const checked = saved && input.tunarrUrl === shownUrl(saved) ? checkTunarrUrl(saved) : checkTunarrUrl(input.tunarrUrl);
      if ('error' in checked) return fail(400, 'invalid_tunarr_url', checked.error);
      const probe = await probeTunarr(config, checked.url, checked.target, config.timeoutMs);
      // What that Tunarr can do, from the same read-only checks Server Settings shows (not cached: it may not be the saved address).
      if (probe.ok) probe.compatibility = compatibilitySummary(await detectCompatibility(config, checked.target));
      return json(200, probe);
    }
    case 'finish': {
      const account = validateAccount(isObject(input.account) ? input.account.username : undefined, isObject(input.account) ? input.account.password : undefined);
      if ('error' in account) return fail(400, 'invalid_account', account.error);
      if (!('tunarrUrl' in input)) return fail(400, 'invalid_tunarr_url', 'Type Tunarr’s address, like http://192.168.1.20:8000.');
      const fields = await applyConnectionFields(setup.stored().values, input, where);
      if ('error' in fields) return fail(400, 'invalid_setup', fields.error);
      const stored = setup.stored();
      const next: StoredConfig = { ...stored, values: fields.values, account: { username: account.username, passwordHash: await hashPassword(account.password) } };
      next.setupComplete = isComplete(next.values, next.account);
      await setup.save(config, next);
      return json(200, { done: true, username: account.username });
    }
    case 'config': {
      if (method === 'GET') return json(200, configView(setup, config));
      const fields = await applyConnectionFields(setup.stored().values, input, where);
      if ('error' in fields) return fail(400, 'invalid_setting', fields.error);
      const stored = setup.stored();
      let account = stored.account;
      if ('account' in input) {
        const change = input.account;
        if (!isObject(change) || typeof change.currentPassword !== 'string') return fail(400, 'invalid_account', 'Type your current password to change the sign-in.');
        if (!account || !(await verifyPassword(change.currentPassword, account.passwordHash))) return fail(403, 'wrong_password', 'That isn’t the current password.');
        const checked = validateAccount(change.username ?? account.username, change.newPassword || change.currentPassword);
        if ('error' in checked) return fail(400, 'invalid_account', checked.error);
        account = { username: checked.username, passwordHash: change.newPassword ? await hashPassword(checked.password) : account.passwordHash };
      }
      if (isObject(input.options)) await config.settings?.update({ ...('scheduler' in input.options ? { LINEUP_SCHEDULER: null } : {}), ...('externalLogos' in input.options ? { LINEUP_EXTERNAL_LOGOS: null } : {}) });
      await setup.save(config, { ...stored, values: fields.values, account, setupComplete: isComplete(fields.values, account) || stored.setupComplete });
      return json(200, configView(setup, config));
    }
  }
}

/** The answer to every other route until setup is done. */
export function setupRequired(health: boolean): ProxyResponse {
  const error = { code: 'setup_required', message: 'Lineup isn’t set up yet. Open it in a browser and follow the setup steps.' };
  return health ? json(503, { status: 'setup_required', error }) : fail(503, error.code, error.message);
}
