// @ts-check
// The desktop app's settings file (lineup.env in the app's data folder). Since
// the setup wizard (D62) it only says where the companion listens; Tunarr's
// address and everything else are set in the app. An older file's TUNARR_URL,
// password and the rest are copied into the companion's config.json once. The
// desktop shell hands the file to the companion process and never to the window.
import { randomInt } from 'node:crypto';

/** Written on first launch so there is a file to open from File → Open Settings File…. */
export const ENV_TEMPLATE = `# Tunarr Lineup desktop settings. Tunarr's address, the sign-in, AI and the
# media folder are set in the app (Setup → Server Settings), not here.
# Save this file, then choose File → Restart Lineup Server.

# Let a TV, iPad or phone on your network use this computer's desk
# (open http://<this computer's address>:3000 there and sign in):
# HOST=0.0.0.0
# PORT=3000
`;

/** The user name the window signs in with (server/auth.ts APP_USER). */
export const APP_USER = 'lineup-desktop';

// The same alphabet and shape as server/setup.ts.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newSetupCode() {
  const chars = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Reads KEY=value lines. Comments, blank lines and malformed lines are skipped;
 * an optional `export ` prefix and matching quotes around the value are dropped.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseLineupEnv(text) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0];
    if (quoted) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    env[key] = value;
  }
  return env;
}

/**
 * The companion's environment: the shell's own, then the settings file, then
 * what the desktop app decides (data and interface folders, listen address).
 * HOST and PORT from the file win so the desk can be shared on the network.
 * The app key and setup code let the window sign in and open the setup wizard.
 * @param {{ processEnv: Record<string, string | undefined>, fileEnv: Record<string, string>, dataDir: string, staticDir: string, port: number, appKey?: string, setupCode?: string }} options
 * @returns {Record<string, string>}
 */
export function companionEnv({ processEnv, fileEnv, dataDir, staticDir, port, appKey, setupCode }) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) env[key] = value;
  Object.assign(env, fileEnv);
  env.NODE_ENV = 'production';
  env.STATIC_DIR = staticDir;
  env.LINEUP_DATA_DIR = fileEnv.LINEUP_DATA_DIR || dataDir;
  env.HOST = fileEnv.HOST || '127.0.0.1';
  env.PORT = String(port);
  if (appKey) env.LINEUP_APP_KEY = appKey;
  if (setupCode) env.LINEUP_SETUP_CODE = setupCode;
  return env;
}

/**
 * The port from the settings file, or null to let the app pick one.
 * @param {Record<string, string>} fileEnv
 */
export function configuredPort(fileEnv) {
  const port = Number(fileEnv.PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}
