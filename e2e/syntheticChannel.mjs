// Synthetic programming shaped like Tunarr's GET /api/channels/:id/programming,
// for the large-channel tests (e2e/large-channel.spec.ts, tests/largeChannel.test.ts).
// Each program carries the full metadata Tunarr sends (identifiers, artwork,
// summary…), about 3.5 KB like a real Plex episode, and flex items carry an
// icon address the way Tunarr stores them. Deterministic for a given seed.
const MINUTE = 60_000;

const hex = (value, width) => value.toString(16).padStart(width, '0');
/** A stable UUID-shaped id; `kind` keeps programs, shows and channels apart. */
export const syntheticId = (kind, index) => `${hex(kind, 8)}-1a2b-4c3d-8e9f-${hex(index, 12)}`;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['north', 'harbor', 'signal', 'evening', 'river', 'atlas', 'quiet', 'summit', 'garden', 'copper', 'lantern', 'meadow'];

function richProgram(id, index, rand, spotMs) {
  const show = index % 40;
  const words = Array.from({ length: 3 }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  const title = `${words[0][0].toUpperCase()}${words[0].slice(1)} ${words[1]} ${index}`;
  const showId = syntheticId(0x7a7a0000, show);
  const duration = spotMs ? spotMs * (1 + (index % 4)) : (20 + (index % 5) * 10) * MINUTE;
  return {
    type: 'content',
    duration,
    id,
    program: {
      mediaSourceId: syntheticId(0x3c3c0000, 1),
      libraryId: syntheticId(0x3c3c0000, 2),
      releaseDate: 1_400_000_000_000 + index * 86_400_000,
      releaseDateString: new Date(1_400_000_000_000 + index * 86_400_000).toISOString(),
      externalId: String(100_000 + index),
      sourceType: 'plex',
      sortTitle: title.toLowerCase(),
      artwork: ['poster', 'thumbnail', 'banner', 'landscape'].map((type) => ({ type, path: `http://127.0.0.1:32400/library/metadata/${100_000 + index}/${type}/1700000000?X-Plex-Token=synthetic-token-${hex(index, 6)}` })),
      state: 'ok',
      uuid: id,
      identifiers: [
        { id: `plex://episode/${hex(index * 7919, 24)}`, type: 'plex-guid' },
        { id: `tt${String(1_000_000 + index)}`, type: 'imdb' },
        { id: String(200_000 + index), type: 'tmdb' },
        { id: String(300_000 + index), type: 'tvdb' },
        { id: String(100_000 + index), sourceId: syntheticId(0x3c3c0000, 1), type: 'plex' },
      ],
      year: 1990 + (index % 30),
      title,
      duration,
      canonicalId: hex(index * 104_729, 40),
      tags: words,
      type: 'episode',
      summary: Array.from({ length: 6 }, () => `The ${words.join(' ')} story continues as the ${WORDS[Math.floor(rand() * WORDS.length)]} crew finds another way home.`).join(' '),
      originalTitle: null,
      episodeNumber: (index % 24) + 1,
      season: { uuid: syntheticId(0x7b7b0000, show * 10 + (index % 3)), index: (index % 3) + 1, title: `Season ${(index % 3) + 1}`, show: { uuid: showId, title: `Show ${show}` } },
      show: { uuid: showId, title: `Show ${show}`, year: 1990 + show, genres: [{ name: 'Drama' }, { name: 'Comedy' }], studios: [{ name: 'Synthetic Studio' }] },
      seasonId: syntheticId(0x7b7b0000, show * 10 + (index % 3)),
      showId,
    },
  };
}

/**
 * `items` lineup entries drawing on `programCount` distinct programs, with a
 * flex break after every fourth program. With `spotMs`, programs are short
 * spots (one to four times that long), so a single day holds a thousand rows
 * or more. Returns the programming body and the channel's summary for GET
 * /api/channels.
 */
export function syntheticProgramming({ items, programCount = Math.max(1, Math.ceil(items / 8)), seed = 7, channelIndex = 1, startTime = Date.now() - 400 * 86_400_000, spotMs = 0 }) {
  const rand = random(seed);
  const programs = {};
  const ids = [];
  for (let index = 0; index < programCount; index += 1) {
    const id = syntheticId(0x9e9e0000 + channelIndex, index);
    ids.push(id);
    programs[id] = richProgram(id, index, rand, spotMs);
  }
  const lineup = [];
  for (let index = 0; lineup.length < items; index += 1) {
    if (index % 5 === 4) {
      lineup.push({ type: 'flex', icon: `http://tunarr.example.invalid:8000/images/uploads/channel-${channelIndex}-logo.png`, duration: spotMs || 4 * MINUTE });
      continue;
    }
    const id = ids[Math.floor(rand() * ids.length)];
    lineup.push({ type: 'content', id, duration: programs[id].duration, persisted: true });
  }
  const duration = lineup.reduce((sum, item) => sum + item.duration, 0);
  const id = syntheticId(0x5d0c0000, 0x100 + channelIndex);
  const name = `Synthetic ${items}${spotMs ? ' spots' : ''}`;
  return {
    channel: { id, name, number: 900 + channelIndex, startTime, duration, programCount: lineup.length, icon: { path: '', width: 0, duration: 0, position: 'bottom-right' } },
    programming: { icon: { path: '' }, name, number: 900 + channelIndex, totalPrograms: lineup.length, programs, lineup, startTimeOffsets: lineup.reduce((offsets, item) => { offsets.push((offsets.at(-1) ?? 0) + item.duration); return offsets; }, []), schedule: undefined },
  };
}
