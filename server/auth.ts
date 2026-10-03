// Optional HTTP Basic authentication for the companion. Off unless
// LINEUP_PASSWORD is set; /healthz always stays open for container checks.
import { createHash, timingSafeEqual } from 'node:crypto';

export type AuthConfig = { username: string; password: string } | null;

export const AUTH_CHALLENGE = { 'www-authenticate': 'Basic realm="Tunarr Lineup", charset="UTF-8"' };

export function createAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const password = env.LINEUP_PASSWORD;
  if (!password) return null;
  return { username: env.LINEUP_USERNAME?.trim() || 'lineup', password };
}

// Hash both sides first so the comparison is constant-time regardless of length.
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
const same = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export function isAuthorized(header: string | undefined, auth: AuthConfig) {
  if (!auth) return true;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!match) return false;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  const userOk = same(decoded.slice(0, split), auth.username);
  const passOk = same(decoded.slice(split + 1), auth.password);
  return userOk && passOk;
}
