// Server settings the desk may change (owner decision 2026-10-19). Only
// settings with nothing to do with security are editable: timeouts, the
// scheduler, public logos, the AI model and the upload limit. Saved values
// (LINEUP_DATA_DIR/settings.json) win over the environment until reset. Addresses,
// keys, the password, allowed hosts and folder paths stay in .env, and the browser
// only learns whether each is set, never its value.
import { createAiConfig } from './ai.js';
import { createJsonFile, StoreError } from './jsonFile.js';
import type { ProxyConfig } from './tunarrProxy.js';

export type SettingKind = 'seconds' | 'megabytes' | 'toggle' | 'text';
type Spec = { key: string; label: string; group: string; help: string; kind: SettingKind; min?: number; max?: number; default: number | boolean | string };

export const EDITABLE_SETTINGS = [
  { key: 'TUNARR_TIMEOUT_MS', label: 'Tunarr request timeout', group: 'Tunarr', kind: 'seconds', min: 1, max: 600, default: 10, help: 'How long to wait for Tunarr to answer a read.' },
  { key: 'TUNARR_SAVE_TIMEOUT_MS', label: 'Tunarr save timeout', group: 'Tunarr', kind: 'seconds', min: 1, max: 3600, default: 30, help: 'How long to wait for Tunarr to save programming.' },
  { key: 'LINEUP_EXTERNAL_LOGOS', label: 'Load logos from public sites', group: 'Tunarr', kind: 'toggle', default: true, help: 'The Lineup server fetches channel logos hosted on public websites.' },
  { key: 'LINEUP_SCHEDULER', label: 'Scheduled changes', group: 'Scheduling', kind: 'toggle', default: false, help: 'Save planned changes to Tunarr on their date, checked every 30 seconds.' },
  { key: 'LINEUP_AI_MODEL', label: 'AI model', group: 'AI', kind: 'text', max: 200, default: '', help: 'The model name the AI provider uses. Empty uses the provider’s default.' },
  { key: 'LINEUP_AI_TIMEOUT_MS', label: 'AI timeout', group: 'AI', kind: 'seconds', min: 10, max: 1800, default: 180, help: 'How long to wait for the AI to answer.' },
  { key: 'LINEUP_MEDIA_MAX_MB', label: 'Largest upload', group: 'Media folder', kind: 'megabytes', min: 1, max: 102_400, default: 4096, help: 'The biggest video file the media folder accepts.' },
] as const satisfies readonly Spec[];

export type SettingKey = (typeof EDITABLE_SETTINGS)[number]['key'];
type Value = number | boolean | string;

/** Shown as set or not, never with their values. */
export const FIXED_SETTINGS: Array<{ keys: string[]; label: string }> = [
  { keys: ['TUNARR_URL'], label: 'Tunarr address' },
  { keys: ['LINEUP_PASSWORD'], label: 'Sign-in password' },
  { keys: ['LINEUP_ALLOWED_HOSTS'], label: 'Allowed host names' },
  { keys: ['LINEUP_DATA_DIR'], label: 'Data folder' },
  { keys: ['LINEUP_MEDIA_DIR'], label: 'Media folder' },
  { keys: ['LINEUP_MEDIA_TUNARR_DIR'], label: 'Media folder as Tunarr sees it' },
  { keys: ['LINEUP_AI_PROVIDER'], label: 'AI provider' },
  { keys: ['LINEUP_AI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'], label: 'AI key' },
  { keys: ['LINEUP_AI_BASE_URL'], label: 'AI address' },
];

export type SettingView = {
  key: SettingKey; label: string; group: string; help: string; kind: SettingKind; min?: number; max?: number;
  value: Value; envValue: Value | null; defaultValue: Value; source: 'saved' | 'env' | 'default';
};
export type SettingsView = { editable: SettingView[]; fixed: Array<{ label: string; set: boolean }>; restartNote: string };

const SPECS = new Map<string, Spec>(EDITABLE_SETTINGS.map((spec) => [spec.key, spec]));
const ON = ['on', 'true', '1', 'yes'];
const OFF = ['off', 'false', '0', 'no'];

/** The env text for a value, read back the way each module already parses it. */
function toEnv(spec: Spec, value: Value): string {
  if (spec.kind === 'toggle') return spec.key === 'LINEUP_SCHEDULER' ? (value ? 'on' : 'off') : value ? 'true' : 'false';
  if (spec.kind === 'seconds') return String(Math.round(Number(value) * 1000));
  return String(value);
}

/** An env string as the value the desk shows, or null when unset or unreadable. */
function fromEnv(spec: Spec, raw: string | undefined): Value | null {
  const text = raw?.trim();
  if (!text) return null;
  if (spec.kind === 'toggle') return ON.includes(text.toLowerCase()) ? true : OFF.includes(text.toLowerCase()) ? false : null;
  if (spec.kind === 'text') return text;
  const number = Number(text);
  if (!Number.isInteger(number) || number <= 0) return null;
  return spec.kind === 'seconds' ? number / 1000 : number;
}

export function validateSetting(key: string, value: unknown): { env: string } | { error: string } {
  const spec = SPECS.get(key);
  if (!spec) return { error: `${key.slice(0, 60)} can’t be changed from the desk.` };
  if (spec.kind === 'toggle') return typeof value === 'boolean' ? { env: toEnv(spec, value) } : { error: `${spec.label}: send true or false.` };
  if (spec.kind === 'text') {
    if (typeof value !== 'string') return { error: `${spec.label}: send text.` };
    const text = value.trim();
    if (text.length > (spec.max ?? 200) || /[\u0000-\u001f\u007f]/.test(text)) return { error: `${spec.label} is too long or has control characters.` };
    return { env: text };
  }
  const number = typeof value === 'number' ? value : NaN;
  const unit = spec.kind === 'seconds' ? 'seconds' : 'MB';
  if (!Number.isInteger(number) || number < (spec.min ?? 1) || number > (spec.max ?? Infinity)) return { error: `${spec.label}: a whole number of ${unit} from ${spec.min} to ${spec.max}.` };
  return { env: toEnv(spec, number) };
}

export type SettingsStore = {
  readonly location: string;
  /** The environment the server started with. */
  readonly env: Record<string, string | undefined>;
  /** Saved values, as env text. */
  saved(): Promise<Record<string, string>>;
  /** `null` drops a saved value, so .env applies again. */
  update(values: Record<string, unknown>): Promise<Record<string, string>>;
};

export function createSettingsStore(dir: string, env: Record<string, string | undefined>): SettingsStore {
  const file = createJsonFile(dir, 'settings.json', 'server settings');
  async function read() {
    const data = (await file.read()) as { values?: unknown } | undefined;
    const out: Record<string, string> = {};
    // Keep only keys that are still editable, with values that still pass.
    if (data?.values && typeof data.values === 'object' && !Array.isArray(data.values)) {
      for (const [key, raw] of Object.entries(data.values)) {
        const spec = SPECS.get(key);
        if (spec && typeof raw === 'string' && (spec.kind === 'text' || fromEnv(spec, raw) !== null)) out[key] = raw;
      }
    }
    return out;
  }
  return {
    location: file.location,
    env,
    saved: () => file.serialize(read),
    update: (values) => file.serialize(async () => {
      const next = await read();
      for (const [key, value] of Object.entries(values)) {
        if (value === null) {
          if (!SPECS.has(key)) throw new StoreError(400, 'invalid_setting', `${key.slice(0, 60)} can’t be changed from the desk.`);
          delete next[key];
          continue;
        }
        const checked = validateSetting(key, value);
        if ('error' in checked) throw new StoreError(400, 'invalid_setting', checked.error);
        next[key] = checked.env;
      }
      await file.write({ version: 1, values: next });
      return next;
    }),
  };
}

export function settingsView(env: Record<string, string | undefined>, saved: Record<string, string>): SettingsView {
  const editable = EDITABLE_SETTINGS.map((spec): SettingView => {
    const envValue = fromEnv(spec, env[spec.key]);
    const savedValue = spec.key in saved ? (spec.kind === 'text' ? saved[spec.key] : fromEnv(spec, saved[spec.key])) : null;
    const source = savedValue !== null ? 'saved' : envValue !== null ? 'env' : 'default';
    const { key, label, group, help, kind } = spec;
    const limits = 'min' in spec ? { min: spec.min, max: spec.max } : 'max' in spec ? { max: spec.max } : {};
    return { key, label, group, help, kind, ...limits, value: savedValue ?? envValue ?? spec.default, envValue, defaultValue: spec.default, source };
  });
  const fixed = FIXED_SETTINGS.map(({ keys, label }) => ({ label, set: keys.some((key) => !!env[key]?.trim()) }));
  return { editable, fixed, restartNote: 'These stay in the .env file (or the container’s environment); change them there and restart the Lineup server.' };
}

/** Applies saved values on top of `env` to a running config. */
export function applySettings(config: ProxyConfig, env: Record<string, string | undefined>, saved: Record<string, string>) {
  const effective = { ...env, ...saved };
  const number = (key: SettingKey, fallback: number) => {
    const value = Number(effective[key]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
  };
  config.timeoutMs = number('TUNARR_TIMEOUT_MS', config.timeoutMs);
  config.saveTimeoutMs = number('TUNARR_SAVE_TIMEOUT_MS', config.saveTimeoutMs);
  config.externalLogos = effective.LINEUP_EXTERNAL_LOGOS?.trim().toLowerCase() !== 'false';
  // Rebuilt from the same reader, so a model set here can turn AI on; a test fetch hook is kept.
  const before = config.ai;
  const ai = createAiConfig(effective);
  if (before && !('off' in before) && before.fetchImpl && !('off' in ai)) ai.fetchImpl = before.fetchImpl;
  config.ai = ai;
  if (config.mediaFolder && !('off' in config.mediaFolder)) config.mediaFolder.maxBytes = number('LINEUP_MEDIA_MAX_MB', config.mediaFolder.maxBytes / 1024 / 1024) * 1024 * 1024;
  const scheduler = effective.LINEUP_SCHEDULER?.trim().toLowerCase();
  config.scheduler?.setEnabled(scheduler === 'on' || scheduler === 'true' || scheduler === '1');
}
