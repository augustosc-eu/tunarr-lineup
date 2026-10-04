// How lineup items are titled, described and illustrated in the interface.
import { isCommercialBreak as isBreak } from './broadcast';
import type { LineupItem, Program, Programming } from './lineup';

export function getProgram(item: LineupItem, programs: Programming['programs']): Program | undefined {
  if (!item.id) return undefined;
  const entry = programs[item.id];
  if (!entry) return undefined;
  // Tunarr wraps metadata in `program`; older payloads and demo data may not.
  const wrapped = (entry as { program?: Program }).program;
  return wrapped && typeof wrapped === 'object' ? wrapped : (entry as Program);
}

export function programTitle(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  if (program?.type === 'episode') return program.show?.title || program.season?.show?.title || program.showTitle || program.title || 'Episode';
  if (program?.type === 'track') return program.artistName || program.title || 'Track';
  if (program?.title) return program.title;
  if (item.type === 'flex') return isBreak(item) ? 'Commercial break' : 'Flex time';
  if (item.type === 'redirect') return String(item.channelName || 'Channel redirect');
  if (item.type === 'custom') return 'Custom show';
  if (item.type === 'filler') return 'Filler';
  return 'Untitled program';
}

export function programDetail(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  if (!program) {
    if (item.type === 'flex') return isBreak(item) ? `Filler from ${(item.fillerConfig as { fillerListIds: unknown[] }).fillerListIds.length} ${(item.fillerConfig as { fillerListIds: unknown[] }).fillerListIds.length === 1 ? 'list' : 'lists'}` : 'Open airtime';
    if (item.type === 'redirect') return `Redirect to CH ${String(item.channelNumber ?? '')}`.trim();
    return item.type;
  }
  if (program.type === 'episode') {
    const season = program.seasonNumber ?? program.season?.index ?? program.season?.number;
    const episode = program.episodeNumber;
    const number = season != null && episode != null ? `S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')} · ` : '';
    return `${number}${program.title || 'Episode'}`;
  }
  if (program.type === 'track') return [program.albumName, program.title].filter(Boolean).join(' · ');
  return [program.year, program.type && program.type.replace('_', ' ')].filter(Boolean).join(' · ');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ARTWORK_KINDS = ['poster', 'thumbnail', 'landscape', 'banner'] as const;
export type ArtworkKind = (typeof ARTWORK_KINDS)[number];

/**
 * Artwork comes through the companion's own /api/tunarr/programs route, so
 * the browser never contacts Tunarr or a media server directly. Embedded
 * data: images are used as-is. Demo data has no artwork.
 */
export function programArtwork(item: LineupItem, programs: Programming['programs'], live: boolean, kind: ArtworkKind = 'poster') {
  if (typeof item.icon === 'string' && item.icon.startsWith('data:image/')) return item.icon;
  if (!live || !item.id || !UUID.test(item.id) || !['content', 'custom', 'filler'].includes(item.type)) return undefined;
  if (!getProgram(item, programs)) return undefined;
  return `/api/tunarr/programs/${item.id}/artwork/${kind}`;
}

const shortHash = (text: string) => {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0;
  return hash.toString(36);
};

/**
 * The channel's logo, served by the companion (which loads it from Tunarr or
 * the public site it lives on). `v` changes with the stored logo so a new logo
 * isn't hidden by the browser cache. Demo channels and channels without a logo
 * have none.
 */
export function channelLogoUrl(channel: { id: string; icon?: { path?: string } }, live: boolean) {
  const path = channel.icon?.path;
  if (!live || typeof path !== 'string' || !path.trim()) return undefined;
  return `/api/tunarr/channels/${encodeURIComponent(channel.id)}/logo?v=${shortHash(path)}`;
}
