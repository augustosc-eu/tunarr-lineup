// @ts-check
// The desktop app's settings file (lineup.env in the app's data folder). Same
// variables as the companion's .env; the desktop shell hands them to the
// companion process and never to the window, so TUNARR_URL stays server-side.

/** Written on first launch so there is a file to open from File → Open Settings File…. */
export const ENV_TEMPLATE = `# Tunarr Lineup desktop settings. Same variables as the server's .env (see the README).
# Save this file, then choose File → Restart Lineup Server.

# Your Tunarr, as this computer reaches it:
# TUNARR_URL=http://localhost:8000

# Let a TV, iPad or phone on your network use this computer's desk
# (open http://<this computer's address>:3000 there). Set a password first:
# HOST=0.0.0.0
# PORT=3000
# LINEUP_PASSWORD=

# Save scheduled changes while the app is open:
# LINEUP_SCHEDULER=on
`;

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
 * @param {{ processEnv: Record<string, string | undefined>, fileEnv: Record<string, string>, dataDir: string, staticDir: string, port: number }} options
 * @returns {Record<string, string>}
 */
export function companionEnv({ processEnv, fileEnv, dataDir, staticDir, port }) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [key, value] of Object.entries(processEnv)) if (value !== undefined) env[key] = value;
  Object.assign(env, fileEnv);
  env.NODE_ENV = 'production';
  env.STATIC_DIR = staticDir;
  env.LINEUP_DATA_DIR = fileEnv.LINEUP_DATA_DIR || dataDir;
  env.HOST = fileEnv.HOST || '127.0.0.1';
  env.PORT = String(port);
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
