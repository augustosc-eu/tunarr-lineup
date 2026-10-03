// Types and helpers for browsing Tunarr's indexed libraries and building the
// program entries channels, filler lists and custom shows are made of.
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
