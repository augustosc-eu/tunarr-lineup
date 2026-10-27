// Titles of local video files (music videos, downloads): Tunarr names a file
// it has no metadata for after the file itself, so "Artist - Song (Official
// Video) [dQw4w9WgXcQ]" is all there is to go on. These helpers read an artist
// and a clean title from that for display, grouping and spacing artists apart,
// and order a folder the way a file manager would. Pure: shared with the browser.
// Tunarr's titles are never changed; this is only how Lineup shows them.

/** What a local folder holds: music videos (artists, rotations) or other videos (series, downloads). */
export const VIDEO_KINDS = ['music-videos', 'videos'] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];
export const isVideoKind = (value: unknown): value is VideoKind => VIDEO_KINDS.includes(value as VideoKind);
export const VIDEO_KIND_LABELS: Record<VideoKind, string> = { 'music-videos': 'Music videos', videos: 'Videos' };

export type VideoTitle = { artist?: string; title: string; display: string };

const EXTENSION = /\.(mp4|m4v|mkv|mov|avi|webm|ts|m2ts|mpg|mpeg|wmv|flv)$/i;
// Tags downloads add that say nothing about the video: (Official Video), [1080p], (Remastered 2009)…
const JUNK = /\s*[([{]\s*(?:official(?:\s+(?:hd|4k))?(?:\s+music)?(?:\s+(?:video|audio|lyric\s+video|lyrics?|visuali[sz]er|clip))?|(?:hd|hq|4k)\s+(?:video|upload)|music\s+video|video\s*clip|videoclip|lyrics?(?:\s+video)?|audio|visuali[sz]er|video|hd|hq|4k|uhd|\d{3,4}p(?:\s*\d{2}fps)?|\d{2}fps|remaster(?:ed)?(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?|explicit(?:\s+version)?|clean(?:\s+version)?)\s*[)\]}]/gi;
// yt-dlp's "Title [id]" and youtube-dl's "Title-id": an 11-character video id.
const BRACKET_ID = /\s*\[[A-Za-z0-9_-]{11}\]/g;
const DASH_ID = /-([A-Za-z0-9_-]{11})$/;
const SEPARATOR = /\s+[-–—|]\s+/;
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i;

/** An 11-character run that looks like a generated id (mixed case or digits), not a word. */
const looksLikeId = (value: string) => /\d|_/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value.slice(1)));

/**
 * The artist and title in a file-derived title. Music videos also lose a
 * leading track number ("03 - Artist - Song"); other videos keep theirs,
 * since it's usually the episode.
 */
export function parseVideoTitle(raw: string, kind: VideoKind = 'music-videos'): VideoTitle {
  let text = String(raw ?? '').normalize('NFC').replace(EXTENSION, '');
  if (!/\s/.test(text) && /[_.]/.test(text)) text = text.replace(/[_.]+/g, ' ');
  else text = text.replace(/_+/g, ' ');
  text = text.replace(BRACKET_ID, '');
  const dashId = DASH_ID.exec(text);
  if (dashId && looksLikeId(dashId[1])) text = text.slice(0, dashId.index);
  text = text.replace(JUNK, '').replace(/\s+/g, ' ').trim();
  if (kind === 'music-videos') text = text.replace(/^\d{1,3}\s*[.)\-–]\s+/, '');
  const cleaned = text || String(raw ?? '').trim() || 'Untitled';
  const split = SEPARATOR.exec(cleaned);
  if (!split || split.index === 0) return { title: cleaned, display: cleaned };
  const artist = cleaned.slice(0, split.index).trim();
  const title = cleaned.slice(split.index + split[0].length).trim();
  if (!artist || !title || (kind === 'videos' && /^\d+$/.test(artist))) return { title: cleaned, display: cleaned };
  return { artist, title, display: `${artist} – ${title}` };
}

/** One key per artist: case, accents and "feat. …" don't make a new artist. */
export function artistKey(artist: string) {
  return artist.replace(FEATURING, '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^the\s+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/** File-manager order: "Part 2" before "Part 10". */
export const naturalCompare = (a: string, b: string) => collator.compare(a, b);

type Titled = { title?: unknown };
const titleOf = (item: Titled) => (typeof item.title === 'string' ? item.title : '');

/**
 * How a followed folder's custom show is ordered: other videos by file name
 * (episodes, dated downloads); music videos by artist, then title.
 */
export function folderOrder<T extends Titled>(items: T[], kind: VideoKind): T[] {
  if (kind === 'videos') return [...items].sort((a, b) => naturalCompare(titleOf(a), titleOf(b)));
  const keyed = items.map((item) => {
    const parsed = parseVideoTitle(titleOf(item), kind);
    return { item, artist: parsed.artist ? artistKey(parsed.artist) : artistKey(parsed.title), title: parsed.title };
  });
  return keyed.sort((a, b) => naturalCompare(a.artist, b.artist) || naturalCompare(a.title, b.title)).map((entry) => entry.item);
}

/**
 * A safe folder name inside the media folder, or null: one path segment, no
 * leading dot, nothing Windows or SMB shares refuse.
 */
export function videoFolderName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim();
  if (!name || name.length > 100 || name.startsWith('.') || /[.\s]$/.test(name)) return null;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}
