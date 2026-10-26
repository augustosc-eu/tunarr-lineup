// Lineup's own configuration, set in the setup wizard instead of .env (owner
// decision 2026-10-25, D62): the Tunarr address, the sign-in account, AI, the
// media folder and the tuning settings, in LINEUP_DATA_DIR/config.json. On the
// first start the matching environment variables are copied in once, so an
// existing install keeps working; afterwards the environment is ignored for
// them. The file is owner-only (0600) and the password is kept only as a
// scrypt hash. The rest of the server still reads these keys by their old env
// names, from `configEnv`.
import { createJsonFile, StoreError, type JsonFile } from './jsonFile.js';
import { createAuthConfig, hashPassword, type PasswordHash } from './auth.js';
import { parseTunarrUrl } from './tunarrProxy.js';

/** Keys config.json holds; the environment no longer sets them once it exists. */
export const CONFIG_KEYS = [
  'TUNARR_URL', 'TUNARR_TIMEOUT_MS', 'TUNARR_SAVE_TIMEOUT_MS', 'LINEUP_EXTERNAL_LOGOS', 'LINEUP_SCHEDULER',
  'LINEUP_AI_PROVIDER', 'LINEUP_AI_API_KEY', 'LINEUP_AI_BASE_URL', 'LINEUP_AI_MODEL', 'LINEUP_AI_TIMEOUT_MS',
  'LINEUP_MEDIA_DIR', 'LINEUP_MEDIA_TUNARR_DIR', 'LINEUP_MEDIA_MAX_MB',
  // Operational notifications (D68): the webhook (write-only), its events, names opt-in, the private-network exception.
  'LINEUP_NOTIFY_URL', 'LINEUP_NOTIFY_EVENTS', 'LINEUP_NOTIFY_NAMES', 'LINEUP_NOTIFY_PRIVATE',
] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Read only by the import (and then dropped): the account and the providers' own key names. */
const IMPORT_ONLY = ['LINEUP_PASSWORD', 'LINEUP_USERNAME', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

export type StoredConfig = {
  version: 1;
  setupComplete: boolean;
  values: Partial<Record<ConfigKey, string>>;
  account?: { username: string; passwordHash: PasswordHash };
  /** Which environment variables the first start copied in (names only). */
  importedFromEnv?: string[];
};

export type ConfigStore = {
  readonly location: string;
  read(): Promise<StoredConfig | undefined>;
  write(config: StoredConfig): Promise<void>;
  serialize: JsonFile['serialize'];
};

const KEYS = new Set<string>(CONFIG_KEYS);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isHash = (value: unknown): value is PasswordHash => isObject(value) && value.scheme === 'scrypt' && typeof value.salt === 'string' && typeof value.hash === 'string';

/** Keeps only known keys with text values; anything else in the file is ignored, never trusted. */
export function parseStoredConfig(data: unknown): StoredConfig | undefined {
  if (data === undefined) return undefined;
  if (!isObject(data) || data.version !== 1) throw new StoreError(500, 'store_corrupt', 'config.json is not a Lineup configuration. Fix or move it, then restart.');
  const values: StoredConfig['values'] = {};
  if (isObject(data.values)) {
    for (const [key, value] of Object.entries(data.values)) if (KEYS.has(key) && typeof value === 'string' && value.length <= 4096) values[key as ConfigKey] = value;
  }
  const account = isObject(data.account) && typeof data.account.username === 'string' && isHash(data.account.passwordHash)
    ? { username: data.account.username, passwordHash: data.account.passwordHash }
    : undefined;
  const imported = Array.isArray(data.importedFromEnv) ? data.importedFromEnv.filter((key): key is string => typeof key === 'string') : undefined;
  return { version: 1, setupComplete: data.setupComplete === true && !!account, values, ...(account ? { account } : {}), ...(imported ? { importedFromEnv: imported } : {}) };
}

export function createConfigStore(dir: string): ConfigStore {
  const file = createJsonFile(dir, 'config.json', 'Lineup configuration', { mode: 0o600 });
  return {
    location: file.location,
    read: async () => parseStoredConfig(await file.read()),
    write: (config) => file.write(config),
    serialize: file.serialize,
  };
}

/** Setup is done when Tunarr's address is valid and there is an account. */
export function isComplete(values: StoredConfig['values'], account: StoredConfig['account']) {
  const tunarr = parseTunarrUrl(values.TUNARR_URL);
  return !!account && !!tunarr && 'target' in tunarr;
}

/** The first start: what the environment already sets, with the password hashed. */
export async function importEnv(env: Record<string, string | undefined>): Promise<StoredConfig> {
  const values: StoredConfig['values'] = {};
  const imported: string[] = [];
  for (const key of CONFIG_KEYS) {
    const value = env[key]?.trim();
    if (value) { values[key] = value; imported.push(key); }
  }
  // The providers' own key names become LINEUP_AI_API_KEY, with the provider they imply.
  if (!values.LINEUP_AI_API_KEY) {
    const key = env.ANTHROPIC_API_KEY?.trim() ? 'ANTHROPIC_API_KEY' : env.OPENAI_API_KEY?.trim() ? 'OPENAI_API_KEY' : null;
    if (key && (!values.LINEUP_AI_PROVIDER || values.LINEUP_AI_PROVIDER.toLowerCase() === (key === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'openai'))) {
      values.LINEUP_AI_API_KEY = env[key]!.trim();
      values.LINEUP_AI_PROVIDER ??= key === 'ANTHROPIC_API_KEY' ? 'anthropic' : 'openai';
      imported.push(key);
    }
  }
  const auth = createAuthConfig(env);
  const account = auth?.password ? { username: auth.username, passwordHash: await hashPassword(auth.password) } : undefined;
  if (account) imported.push('LINEUP_PASSWORD', ...(env.LINEUP_USERNAME?.trim() ? ['LINEUP_USERNAME'] : []));
  return { version: 1, setupComplete: isComplete(values, account), values, ...(account ? { account } : {}), importedFromEnv: imported };
}

/** Configuration variables set in the environment, which config.json overrides after the first start. */
export function ignoredEnv(env: Record<string, string | undefined>) {
  return [...CONFIG_KEYS, ...IMPORT_ONLY].filter((key) => env[key]?.trim());
}

/**
 * The environment the rest of the server reads: the process's own (where it
 * listens, the data folder, allowed hosts, tuning) with every configuration
 * key replaced by config.json's.
 */
export function configEnv(env: Record<string, string | undefined>, values: StoredConfig['values']) {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) if (!KEYS.has(key) && !IMPORT_ONLY.includes(key)) out[key] = value;
  return { ...out, ...values };
}

/** An AI model saved from the desk before it moved to AI setup (settings.json), if any. */
export async function savedAiModel(dir: string) {
  const data = await createJsonFile(dir, 'settings.json', 'server settings').read().catch(() => undefined);
  const model = isObject(data) && isObject(data.values) ? data.values.LINEUP_AI_MODEL : undefined;
  return typeof model === 'string' && model.trim() && model.length <= 200 && !/[\u0000-\u001f\u007f]/.test(model) ? model.trim() : null;
}
