// A short fingerprint of a channel's programming (lineup + schedule), shared by
// the browser and the companion so a save can say which version it replaces.
// Not cryptographic: it detects change, it doesn't authenticate. Pure code with
// no Node APIs, because the browser bundle imports it too (and Web Crypto is
// unavailable to pages served over plain HTTP on a LAN).

/** cyrb53: a fast 53-bit string hash with good dispersion. */
function cyrb53(text: string, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Version of a channel's programming as Tunarr returned it. Both sides hash
 * the JSON of objects parsed from the same Tunarr response, so key order
 * matches without canonicalisation.
 */
export function programmingVersion(lineup: unknown, schedule: unknown) {
  const text = JSON.stringify({ lineup: lineup ?? [], schedule: schedule ?? null });
  return `${cyrb53(text).toString(36)}-${cyrb53(text, 0x9e3779b9).toString(36)}-${text.length.toString(36)}`;
}

/** Total length (ms) of a lineup's items, ignoring anything without a positive duration. */
export function lineupLength(lineup: unknown) {
  if (!Array.isArray(lineup)) return 0;
  return lineup.reduce((sum: number, item) => {
    const duration = (item as { duration?: unknown } | null)?.duration;
    return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? sum + duration : sum;
  }, 0);
}

/**
 * A manual lineup repeats from the channel's start time, so changing its
 * length by d moves the pass airing at `now` by d for every pass before it.
 * This is the start time that keeps that pass (what's on air, and the rest of
 * it) where it was: the browser previews with it, and the companion saves it.
 */
export function keptStartTime(startTime: number, oldLength: number, newLength: number, now: number) {
  if (!(oldLength > 0) || !(newLength > 0) || !Number.isFinite(startTime)) return startTime;
  const passes = Math.max(0, Math.floor((now - startTime) / oldLength));
  return Math.max(0, Math.round(startTime + passes * (oldLength - newLength)));
}
