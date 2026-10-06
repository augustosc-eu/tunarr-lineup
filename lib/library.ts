// Types and helpers for browsing Tunarr's indexed libraries and building the
// program entries channels, filler lists and custom shows are made of.
import type { RuleSet } from '../server/smartCollection';
import type { LineupItem } from './lineup';

export type MediaLibrary = { id: string; name: string; mediaType?: string };
export type MediaSource = { id: string; name: string; type?: string; mediaType?: string; libraries: MediaLibrary[] };

/** A search result: a terminal program (movie, episode…) or a folder (show, season…). */
export type LibraryItem = {
  uuid: string;
  type: string;
  title: string;
  duration?: number;
  year?: number | null;
  index?: number;
  episodeNumber?: number;
  childCount?: number;
  [key: string]: unknown;
};

export type SearchResult = { results: LibraryItem[]; page: number; totalPages: number; totalHits: number };

/** Tunarr's full program entry, as filler lists store them and descendants return them. */
export type ContentProgram = { type: 'content'; id: string; duration: number; program: LibraryItem | Record<string, unknown>; [key: string]: unknown };

export type ListSummary = { id: string; name: string; contentCount?: number; totalDuration?: number; synced: boolean };
export type NamedItem = { id: string; name: string };

export type ChannelSettings = {
  id: string;
  name?: string;
  number?: number;
  groupTitle?: string;
  startTime?: number;
  duration?: number;
  guideFlexTitle?: string;
  guideMinimumDuration?: number;
  fillerCollections?: Array<{ id: string; weight: number; cooldownSeconds: number }>;
  fillerRepeatCooldown?: number;
  disableFillerOverlay?: boolean;
  icon?: { path?: string; width?: number; position?: string; duration?: number };
  watermark?: Watermark;
  offline?: { mode: 'pic' | 'clip'; picture?: string; soundtrack?: string };
  streamMode?: string;
  transcodeConfigId?: string;
  subtitlesEnabled?: boolean;
  stealth?: boolean;
  onDemand?: { enabled: boolean };
};

export type Watermark = {
  enabled: boolean;
  url?: string;
  position: string;
  width: number;
  verticalMargin: number;
  horizontalMargin: number;
  duration: number;
  opacity?: number;
  fixedSize?: boolean;
  animated?: boolean;
};

export type TranscodeProfile = {
  id: string;
  name: string;
  isDefault: boolean;
  threadCount?: number;
  hardwareAccelerationMode?: string;
  resolution?: { widthPx: number; heightPx: number };
  videoFormat?: string;
  videoBitDepth?: number | null;
  videoBitRate?: number;
  videoBufferSize?: number;
  audioFormat?: string;
  audioBitRate?: number;
  audioBufferSize?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  audioVolumePercent?: number;
  audioLoudnormConfig?: { i: number; lra: number; tp: number } | null;
  normalizeFrameRate?: boolean;
  deinterlaceVideo?: boolean;
  disableChannelOverlay?: boolean;
  errorScreen?: string;
  errorScreenAudio?: string;
  disableHardwareDecoder?: boolean;
  disableHardwareEncoding?: boolean;
  disableHardwareFilters?: boolean;
};

export type ManagedLibrary = { id: string; name: string; mediaType?: string; enabled: boolean; lastScannedAt?: number; isLocked?: boolean };
export type ManagedSource = { id: string; name: string; type?: string; mediaType?: string; libraries: ManagedLibrary[] };
export type NewMediaSource =
  | { type: 'plex'; name: string; uri: string; accessToken: string }
  | { type: 'jellyfin' | 'emby'; name: string; uri: string; username: string; password: string }
  | { type: 'local'; name: string; mediaType: string; paths: string[] };

export type SmartCollectionView = {
  id: string;
  name: string;
  keywords: string;
  rules: RuleSet | null;
  description: string;
  filterString: string;
};

export const STREAM_MODE_LABELS: Record<string, string> = {
  hls: 'HLS (recommended)',
  hls_slower: 'HLS, alternate (more compatible)',
  mpegts: 'MPEG-TS',
  hls_direct: 'HLS direct (no transcoding)',
  hls_direct_v2: 'HLS direct v2',
};

export const TERMINAL_TYPES = new Set(['movie', 'episode', 'other_video', 'music_video', 'track']);

/** The top-level item type a library lists (a TV library lists shows). */
export function topLevelType(mediaType: string | undefined) {
  switch (mediaType) {
    case 'movies': return 'movie';
    case 'shows': return 'show';
    case 'tracks': return 'artist';
    case 'other_videos': return 'other_video';
    case 'music_videos': return 'music_video';
    default: return undefined;
  }
}

/** What a folder contains: shows hold seasons, seasons hold episodes, and so on. */
export function childType(type: string) {
  switch (type) {
    case 'show': return 'season';
    case 'season': return 'episode';
    case 'artist': return 'album';
    case 'album': return 'track';
    default: return undefined;
  }
}

export const isPlayable = (item: Pick<LibraryItem, 'type' | 'duration'>) => TERMINAL_TYPES.has(item.type) && typeof item.duration === 'number' && item.duration > 0;

export function toContentProgram(item: LibraryItem): ContentProgram {
  return { type: 'content', id: item.uuid, duration: item.duration ?? 0, program: item };
}

/** Lineup entry for a program, plus the metadata entry the interface titles it from. */
export function lineupEntry(program: ContentProgram): { item: LineupItem; meta: [string, ContentProgram] } {
  return { item: { type: 'content', id: program.id, duration: program.duration }, meta: [program.id, program] };
}

export function itemLabel(item: LibraryItem) {
  if (item.type === 'season') return item.title || `Season ${item.index ?? ''}`.trim();
  if (item.type === 'episode') return `${item.episodeNumber != null ? `E${String(item.episodeNumber).padStart(2, '0')} · ` : ''}${item.title}`;
  return item.year ? `${item.title} (${item.year})` : item.title;
}

export const TYPE_LABELS: Record<string, string> = {
  show: 'Show', season: 'Season', episode: 'Episode', movie: 'Movie', other_video: 'Video', music_video: 'Music video', artist: 'Artist', album: 'Album', track: 'Track',
};

/** Season numbers and episode counts from a show's episodes (when a season search isn't possible). */
export function seasonsFromEpisodes(episodes: ContentProgram[]): Array<{ number: number; title: string; episodes: number }> {
  const counts = new Map<number, number>();
  for (const episode of episodes) {
    const meta = episode.program as { seasonNumber?: number; season?: { index?: number } } | undefined;
    const number = meta?.season?.index ?? meta?.seasonNumber;
    if (Number.isInteger(number)) counts.set(number as number, (counts.get(number as number) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => a[0] - b[0]).map(([number, count]) => ({ number, title: number === 0 ? 'Specials' : `Season ${number}`, episodes: count }));
}

// ------------------------------------------------- browsing a whole listing

/** How the library browser orders a fully loaded listing. */
export type LibrarySort = 'number' | 'title' | 'date';

export const LIBRARY_SORT_LABELS: Record<LibrarySort, string> = {
  number: 'Episode number',
  title: 'Title',
  date: 'Release date',
};

/** Lowercase without accents, so "capitulo" finds "Capítulo". */
export const foldText = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Every whole number in a title, in order: "Chapter 2 - Part 10" → [2, 10]. */
export const titleNumbers = (title: string) => (title.match(/\d+/g) ?? []).map(Number);

/**
 * The number a title is ordered by: its first number ("Capítulo 2 - …" and
 * "Chapter 2 - …" are both episode 2), or null when it has none.
 */
export function titleNumber(item: Pick<LibraryItem, 'title'>) {
  const [first] = titleNumbers(item.title ?? '');
  return first ?? null;
}

const naturalTitle = (a: LibraryItem, b: LibraryItem) => (a.title ?? '').localeCompare(b.title ?? '', undefined, { numeric: true, sensitivity: 'base' });
const releaseTime = (item: LibraryItem) => {
  const value = item.releaseDate;
  return typeof value === 'number' && Number.isFinite(value) ? value : item.year ? Date.UTC(item.year, 0, 1) : Infinity;
};

/** Episode-number order when most programs here carry a number in their title, title order otherwise. */
export function defaultLibrarySort(items: LibraryItem[]): LibrarySort {
  const programs = items.filter((item) => TERMINAL_TYPES.has(item.type));
  if (programs.length < 2) return 'title';
  return programs.filter((item) => titleNumber(item) !== null).length >= programs.length * 0.6 ? 'number' : 'title';
}

/**
 * Orders a listing. Titles compare naturally ("Part 2" before "Part 10");
 * by number, items without one go last; by date, undated items go last.
 */
export function sortLibraryItems(items: LibraryItem[], sort: LibrarySort) {
  const next = [...items];
  if (sort === 'title') return next.sort(naturalTitle);
  if (sort === 'date') return next.sort((a, b) => releaseTime(a) - releaseTime(b) || naturalTitle(a, b));
  return next.sort((a, b) => {
    const x = titleNumber(a);
    const y = titleNumber(b);
    if (x !== y) return x === null ? 1 : y === null ? -1 : x - y;
    return naturalTitle(a, b);
  });
}

/**
 * Finds items in a loaded listing. Accents and case are ignored. Numbers in
 * the search must be numbers of the title (or its year), so "capitulo 2"
 * finds "Chapter 2 - …" but not "Capítulo 20". Words narrow the results when
 * some titles contain all of them; otherwise they only rank, so a title in
 * another language still turns up by its number.
 */
export function findLibraryItems(items: LibraryItem[], search: string) {
  const tokens = foldText(search).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return items;
  const numbers = tokens.filter((token) => /^\d+$/.test(token)).map(Number);
  const words = tokens.filter((token) => !/^\d+$/.test(token));
  const byNumber = items.filter((item) => {
    const own = [...titleNumbers(item.title ?? ''), ...(item.year ? [item.year] : [])];
    return numbers.every((number) => own.includes(number));
  });
  const wordsIn = (item: LibraryItem) => words.filter((word) => foldText(item.title ?? '').includes(word)).length;
  const full = byNumber.filter((item) => wordsIn(item) === words.length);
  if (full.length || !numbers.length) return full;
  // The number matched but the words didn't (another language): rank by words matched.
  return [...byNumber].sort((a, b) => wordsIn(b) - wordsIn(a));
}
