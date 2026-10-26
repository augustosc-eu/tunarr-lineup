// The guide preview (roadmap milestone 6, D69): what Tunarr's guide says for
// the hours ahead, as an XMLTV listing would carry it, and what looks wrong in
// it. Tunarr builds and serves the real XMLTV; Lineup doesn't publish a guide
// of its own (see D69), so this is a preview and a check, made in the browser
// from the guide the desk already reads. Pure.
import type { GuideChannel, GuideEntry } from '../server/watch';

export type EpgEntry = { start: number; stop: number; title: string; subtitle: string; category: string; flex: boolean };
export type EpgIssue = { severity: 'warning' | 'info'; at: number; title: string; detail: string };

const CATEGORY: Record<string, string> = { content: 'Program', flex: 'Filler', redirect: 'Simulcast', custom: 'Program', filler: 'Filler' };

/** The listing's entries for a channel, in time order. */
export const epgEntries = (channel: GuideChannel): EpgEntry[] => [...channel.programs].sort((a, b) => a.start - b.start).map((entry: GuideEntry) => ({
  start: entry.start, stop: entry.stop, title: entry.title || 'Untitled', subtitle: entry.detail, category: CATEGORY[entry.type] ?? 'Program', flex: entry.type === 'flex',
}));

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const minutes = (ms: number) => Math.round(ms / 60_000);

/**
 * What a viewer's guide would show oddly: holes and overlaps, entries too
 * short to read (under `minimumMs`, the channel's minimum guide entry when it
 * has one), very long entries, untitled ones, and flex time listed with the
 * channel's own name (set a guide title for flex in Channel Settings).
 */
export function epgIssues(channel: GuideChannel, from: number, to: number, settings: { minimumMs?: number; flexTitle?: string } = {}): EpgIssue[] {
  const entries = epgEntries(channel).filter((entry) => entry.stop > from && entry.start < to);
  const issues: EpgIssue[] = [];
  if (!entries.length) return [{ severity: 'warning', at: from, title: 'Nothing in the guide', detail: `Tunarr’s guide has nothing for CH ${channel.number} in these hours; guide apps will show it empty.` }];
  if (entries[0].start > from) issues.push({ severity: 'warning', at: from, title: `${minutes(entries[0].start - from)} minutes missing at the start`, detail: `Nothing listed from ${clock(from)} to ${clock(entries[0].start)}.` });
  const minimum = settings.minimumMs ?? 60_000;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const next = entries[index + 1];
    if (next && next.start > entry.stop) issues.push({ severity: 'warning', at: entry.stop, title: `A ${minutes(next.start - entry.stop)}-minute hole`, detail: `Nothing listed from ${clock(entry.stop)} to ${clock(next.start)}.` });
    if (next && next.start < entry.stop) issues.push({ severity: 'warning', at: next.start, title: 'Two entries overlap', detail: `“${entry.title}” runs until ${clock(entry.stop)}, but “${next.title}” starts at ${clock(next.start)}.` });
    if (entry.stop - entry.start < minimum && !entry.flex) issues.push({ severity: 'info', at: entry.start, title: `A ${Math.max(1, Math.round((entry.stop - entry.start) / 1000))}-second entry`, detail: `“${entry.title}” at ${clock(entry.start)} is too short to read in a guide. Channel Settings → General → minimum guide entry folds short items into their neighbours.` });
    if (entry.stop - entry.start > 6 * 3_600_000) issues.push({ severity: 'info', at: entry.start, title: `A ${Math.round((entry.stop - entry.start) / 3_600_000)}-hour entry`, detail: `“${entry.title}” at ${clock(entry.start)} fills a long stretch with one listing.` });
    if (entry.title === 'Untitled') issues.push({ severity: 'warning', at: entry.start, title: 'An untitled entry', detail: `At ${clock(entry.start)}.` });
    if (entry.flex && !settings.flexTitle && (entry.title === channel.name || entry.title === 'Flex time')) issues.push({ severity: 'info', at: entry.start, title: 'Flex time listed with a generic title', detail: `At ${clock(entry.start)}. Set a guide title for flex time in Channel Settings → General.` });
  }
  const last = entries.at(-1)!;
  if (last.stop < to) issues.push({ severity: 'warning', at: last.stop, title: `${minutes(to - last.stop)} minutes missing at the end`, detail: `Nothing listed after ${clock(last.stop)}.` });
  // Several short entries in a row become one line each; say it once per kind.
  const seen = new Set<string>();
  return issues.filter((issue) => { const key = issue.title.replace(/\d+/g, '#'); if (issue.severity === 'info' && seen.has(key)) return false; seen.add(key); return true; });
}

const escape = (text: string) => text.replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!)
  // Characters XML 1.0 can't carry at all.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');

/** XMLTV's time: 20261031200000 +0000. */
export const xmltvTime = (ms: number) => `${new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14)} +0000`;

/**
 * The preview as an XMLTV document (for looking at, not for guide apps:
 * Tunarr serves the real one). Channel ids are Tunarr's channel ids.
 */
export function toXmltv(channels: GuideChannel[], from: number, to: number) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<!-- Preview made by Tunarr Lineup from Tunarr’s guide. Tunarr serves the real guide; point guide apps at Tunarr, not at this file. -->', '<tv generator-info-name="Tunarr Lineup (preview)">'];
  for (const channel of channels) lines.push(`  <channel id="${escape(channel.id)}"><display-name>${escape(channel.name)}</display-name><display-name>${channel.number}</display-name></channel>`);
  for (const channel of channels) {
    for (const entry of epgEntries(channel).filter((item) => item.stop > from && item.start < to)) {
      lines.push(`  <programme start="${xmltvTime(entry.start)}" stop="${xmltvTime(entry.stop)}" channel="${escape(channel.id)}"><title>${escape(entry.title)}</title>${entry.subtitle ? `<sub-title>${escape(entry.subtitle)}</sub-title>` : ''}<category>${escape(entry.category)}</category></programme>`);
    }
  }
  lines.push('</tv>');
  return `${lines.join('\n')}\n`;
}
