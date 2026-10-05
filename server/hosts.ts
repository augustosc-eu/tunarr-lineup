// Host-name check against DNS rebinding. A web page on any site can point its
// own host name at this machine's address; the browser then treats Lineup as
// that site, sends the attacker's host in both Origin and Host, and the Origin
// check alone can't tell. Answering only to IP addresses, localhost and the
// names in LINEUP_ALLOWED_HOSTS closes that. With sign-in on, the browser holds
// the password for Lineup's real address only, so a rebound name gets 401 and
// this check isn't needed.
import { isIP } from 'node:net';

export type HostPolicy = { any: boolean; names: string[] };

/** LINEUP_ALLOWED_HOSTS: comma-separated names; ".example.com" also allows subdomains; "*" allows any. */
export function createHostPolicy(env: Record<string, string | undefined>): HostPolicy {
  const names = (env.LINEUP_ALLOWED_HOSTS ?? '').split(',').map((name) => name.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  return { any: names.includes('*'), names: names.filter((name) => name !== '*') };
}

/** The host name of a Host header, without port or IPv6 brackets. */
export function hostName(header: string) {
  const value = header.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1];
  return value.replace(/:\d+$/, '').replace(/\.$/, '');
}

export function isAllowedHost(header: string | undefined, policy: HostPolicy) {
  // Browsers always send Host; a client that leaves it out isn't a rebound page.
  if (!header || policy.any) return true;
  const name = hostName(header);
  if (isIP(name) || name === 'localhost' || name.endsWith('.localhost')) return true;
  return policy.names.some((allowed) => (allowed.startsWith('.') ? name.endsWith(allowed) || name === allowed.slice(1) : name === allowed));
}

export function hostRefusal(header: string) {
  const name = hostName(header).slice(0, 100);
  return `Lineup doesn't answer to the host name "${name}". Open it by IP address or as localhost, or add ${name} to LINEUP_ALLOWED_HOSTS on the Lineup server (or turn on sign-in with LINEUP_PASSWORD).`;
}
