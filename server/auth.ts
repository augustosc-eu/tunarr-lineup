// HTTP Basic authentication for the companion. The account is made in the
// setup wizard and kept as a scrypt hash in config.json (server/configStore.ts);
// before setup is done there is none and the setup code guards the wizard
// instead. /healthz always stays open for container checks.
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type PasswordHash = { scheme: 'scrypt'; salt: string; hash: string };

export type AuthConfig = {
  username: string;
  /** Plain text, only from createAuthConfig (tests, the one-time import). */
  password?: string;
  passwordHash?: PasswordHash;
  /** The desktop app's per-launch key, so its own window signs in by itself. */
  appKey?: string;
} | null;

/** The user name the desktop window signs in with, using its app key. */
export const APP_USER = 'lineup-desktop';

export const AUTH_CHALLENGE = { 'www-authenticate': 'Basic realm="Tunarr Lineup", charset="UTF-8"' };

export function createAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const password = env.LINEUP_PASSWORD;
  if (!password) return null;
  return { username: env.LINEUP_USERNAME?.trim() || 'lineup', password };
}

// Hash both sides first so the comparison is constant-time regardless of length.
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

// N=2^15 takes ~50 ms: slow for guessing, fine for a sign-in.
const SCRYPT = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const derive = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password.normalize('NFKC'), salt, 64, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
});

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = Buffer.from(randomBytes(16));
  return { scheme: 'scrypt', salt: salt.toString('base64'), hash: Buffer.from(await derive(password, salt)).toString('base64') };
}

export async function verifyPassword(password: string, stored: PasswordHash) {
  if (stored.scheme !== 'scrypt') return false;
  const expected = Buffer.from(stored.hash, 'base64');
  const actual = await derive(password, Buffer.from(stored.salt, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Lengths and characters the wizard accepts for an account. */
export function validateAccount(username: unknown, password: unknown): { username: string; password: string } | { error: string } {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(name)) return { error: 'User name: 1 to 64 letters, digits, dots, dashes, underscores or @.' };
  if (name === APP_USER) return { error: `${APP_USER} is reserved for the desktop app.` };
  if (typeof password !== 'string' || password.length < 8) return { error: 'Password: at least 8 characters.' };
  if (password.length > 256 || /[\u0000-\u001f\u007f]/.test(password)) return { error: 'Password: at most 256 characters, with no control characters.' };
  return { username: name, password };
}

function credentials(header: string | undefined) {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  return split < 0 ? null : { user: decoded.slice(0, split), pass: decoded.slice(split + 1) };
}

/** The check for plain-text passwords and the app key; a hashed account needs `authorize`. */
export function isAuthorized(header: string | undefined, auth: AuthConfig) {
  if (!auth) return true;
  const given = credentials(header);
  if (!given) return false;
  if (auth.appKey && same(given.user, APP_USER) && same(given.pass, auth.appKey)) return true;
  if (auth.password === undefined) return false;
  const userOk = same(given.user, auth.username);
  const passOk = same(given.pass, auth.password);
  return userOk && passOk;
}

// Basic sends the password with every request, so a match is remembered (by a
// digest, never the password) instead of running scrypt each time.
const verified = new Set<string>();
const MAX_VERIFIED = 64;

// Each scrypt run takes ~32 MB, so a flood of wrong passwords waits its turn
// instead of running all at once and exhausting memory.
let freeSlots = 2;
const waiting: Array<() => void> = [];
async function oneAtATime<T>(task: () => Promise<T>) {
  if (freeSlots > 0) freeSlots -= 1;
  else await new Promise<void>((resolve) => waiting.push(resolve));
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else freeSlots += 1;
  }
}

export async function authorize(header: string | undefined, auth: AuthConfig) {
  if (isAuthorized(header, auth)) return true;
  const given = credentials(header);
  if (!auth?.passwordHash || !given || !same(given.user, auth.username)) return false;
  const key = createHash('sha256').update(`${auth.passwordHash.hash}\0${auth.username}\0${given.pass}`, 'utf8').digest('base64');
  if (verified.has(key)) return true;
  if (!(await oneAtATime(() => verifyPassword(given.pass, auth.passwordHash!)))) return false;
  if (verified.size >= MAX_VERIFIED) verified.delete(verified.values().next().value!);
  verified.add(key);
  return true;
}
