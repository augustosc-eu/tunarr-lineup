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
