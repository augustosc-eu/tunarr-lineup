// A channel's health for the Control Room (roadmap milestone 2): the problems a
// broadcaster would want to know about before a viewer finds them, worked out
// from what Tunarr returned for the channel. Pure, so every rule is tested
// without a server; the desk's own lineup check (lib/lineupCheck.ts) goes
// further for the channel open in the desk. Findings name lineup positions and
// program titles, never addresses or paths.

export type HealthStatus = 'healthy' | 'warning' | 'error' | 'unknown' | 'unsupported';
export type FindingSeverity = 'error' | 'warning' | 'info';

export type Finding = {
  id: string;
  severity: FindingSeverity;
  title: string;
  detail: string;
  /** The first lineup position it concerns. */
  lineupIndex?: number;
};

export type ChannelDiagnostic = {
  channelId: string;
  checkedAt: number;
  status: HealthStatus;
  /** Manual lineup, generated from a slot schedule, or empty. */
  mode: 'manual' | 'generated' | 'empty' | 'unknown';
  items: number;
  cycleMs: number;
  findings: Finding[];
  /** Channels this one redirects to, for loop checks across channels. */
  redirects: string[];
  /** Why the check couldn't finish, in Lineup's words. */
  error?: string;
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const positions = (indexes: number[]) => `${indexes.slice(0, 6).map((index) => `#${index + 1}`).join(', ')}${indexes.length > 6 ? '…' : ''}`;
const duration = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/** A flex item that's a commercial break carries its own filler lists. */
const breakLists = (item: Json): string[] | null => {
  const config = isObject(item.fillerConfig) ? item.fillerConfig : null;
  return config && Array.isArray(config.fillerListIds) ? config.fillerListIds.filter((id): id is string => typeof id === 'string') : null;
};

/** The lineup position airing at `at`, walking the cycle from the channel's start; -1 when it can't be told. */
export function positionAt(lineup: Json[], startTime: number, at: number): number {
  const lengths = lineup.map((item) => (typeof item.duration === 'number' && item.duration > 0 ? item.duration : 0));
  const cycle = lengths.reduce((sum, value) => sum + value, 0);
  if (!cycle || !Number.isFinite(startTime) || at < startTime) return -1;
  let offset = (at - startTime) % cycle;
  for (let index = 0; index < lengths.length; index += 1) {
    if (offset < lengths[index]) return index;
    offset -= lengths[index];
  }
  return -1;
}

/** The channels a redirect loop through `channelId` visits, ending back at it, or null. */
export function findLoop(channelId: string, edges: Map<string, string[]>): string[] | null {
  const seen = new Set<string>();
  const walk = (at: string, path: string[]): string[] | null => {
    for (const to of edges.get(at) ?? []) {
      if (to === channelId) return [...path, to];
      if (seen.has(to)) continue;
      seen.add(to);
      const found = walk(to, [...path, to]);
      if (found) return found;
    }
    return null;
  };
  return walk(channelId, [channelId]);
}

export type HealthInput = {
  channelId: string;
  /** Tunarr's programming reply for the channel. */
  programming: unknown;
  /** Tunarr's channel document: start time and filler lists. */
  channel: unknown;
  /** Every channel that exists: id → "CH 5 News". */
  channelNames: Map<string, string>;
  /** Filler lists that exist in Tunarr, or null when they couldn't be read. */
  fillerListIds: Set<string> | null;
  /** What Tunarr's guide says airs now, or null when the guide wasn't read. */
  guideNow: { type: string; id?: string; title?: string } | null;
  now: number;
};

/** The findings for one channel (loops come from loopFindings; sort with sortFindings). */
export function channelFindings(input: HealthInput): Pick<ChannelDiagnostic, 'mode' | 'items' | 'cycleMs' | 'findings' | 'redirects'> {
  const programming = isObject(input.programming) ? input.programming : {};
  const lineup = (Array.isArray(programming.lineup) ? programming.lineup : []).filter(isObject);
  const programs = isObject(programming.programs) ? programming.programs : {};
  const generated = programming.schedule != null;
  const channel = isObject(input.channel) ? input.channel : {};
  const findings: Finding[] = [];
  const add = (finding: Finding) => findings.push(finding);
  const cycleMs = lineup.reduce((sum, item) => sum + (typeof item.duration === 'number' && item.duration > 0 ? item.duration : 0), 0);

  // Programs Tunarr no longer has: the lineup names them, but Tunarr sent no details.
  const missing = lineup.flatMap((item, index) => (item.type === 'content' && typeof item.id === 'string' && !isObject(programs[item.id]) ? [index] : []));
  if (missing.length) add({ id: 'missing-program', severity: 'error', lineupIndex: missing[0], title: `${plural(missing.length, 'program')} Tunarr no longer has`, detail: `Lineup position${missing.length === 1 ? '' : 's'} ${positions(missing)}. Tunarr skips them or shows the offline screen. Media Repair can remove or replace them.` });

  const zero = lineup.flatMap((item, index) => (!(typeof item.duration === 'number' && item.duration > 0) ? [index] : []));
  if (zero.length) add({ id: 'zero-length', severity: 'warning', lineupIndex: zero[0], title: `${plural(zero.length, 'item')} with no length`, detail: `Positions ${positions(zero)}. Tunarr won’t accept them, so a save leaves them out.` });

  const redirects = new Set<string>();
  lineup.forEach((item, index) => {
    if (item.type !== 'redirect') return;
    const target = typeof item.channel === 'string' ? item.channel : '';
    redirects.add(target);
    if (target === input.channelId) add({ id: `redirect-self-${index}`, severity: 'error', lineupIndex: index, title: 'A redirect to this same channel', detail: `#${index + 1} sends viewers back to this channel, which Tunarr can’t play.` });
    else if (!input.channelNames.has(target)) add({ id: `redirect-missing-${index}`, severity: 'error', lineupIndex: index, title: 'A redirect to a channel that no longer exists', detail: `#${index + 1}: Tunarr turns it into off-air time.` });
  });
  const slots = isObject(programming.schedule) && Array.isArray(programming.schedule.slots) ? programming.schedule.slots : [];
  for (const slot of slots) if (isObject(slot) && slot.type === 'redirect' && typeof slot.channelId === 'string') redirects.add(slot.channelId);

  if (input.fillerListIds) {
    const gone = lineup.flatMap((item, index) => {
      const lists = item.type === 'flex' ? breakLists(item) : null;
      return lists?.some((id) => !input.fillerListIds!.has(id)) ? [index] : [];
    });
    if (gone.length) add({ id: 'break-missing-list', severity: 'error', lineupIndex: gone[0], title: `${plural(gone.length, 'commercial break')} filled from a deleted filler list`, detail: `Positions ${positions(gone)}.` });
  }

  // Flex with nothing to fill it: the offline screen. Only said when the channel's filler lists are known.
  const plainFlex = lineup.flatMap((item, index) => (item.type === 'flex' && !breakLists(item)?.length ? [index] : []));
  if (plainFlex.length && Array.isArray(channel.fillerCollections) && !channel.fillerCollections.length) {
    const total = plainFlex.reduce((sum, index) => sum + Math.max(0, Number(lineup[index].duration) || 0), 0);
    add({ id: 'flex-offline', severity: 'warning', lineupIndex: plainFlex[0], title: `${duration(total)} of flex time with no filler`, detail: 'The channel has no filler lists, so Tunarr shows the offline screen. Add lists in Channel Settings → Commercials (or with a batch filler change).' });
  }

  // Guide against lineup: claimed only for a manual lineup, when both name a program and they differ.
  if (!generated && input.guideNow && lineup.length && typeof channel.startTime === 'number') {
    const index = positionAt(lineup, channel.startTime, input.now);
    const projected = index >= 0 ? lineup[index] : null;
    if (projected?.type === 'content' && input.guideNow.type === 'content' && input.guideNow.id && projected.id !== input.guideNow.id) {
      add({ id: 'guide-drift', severity: 'warning', lineupIndex: index, title: 'Tunarr’s guide disagrees with the lineup', detail: `The lineup has #${index + 1} on air now, but the guide shows ${input.guideNow.title ? `“${input.guideNow.title.slice(0, 80)}”` : 'another program'}. Tunarr may not have rebuilt its guide since the last change.` });
    }
  }
  return { mode: !lineup.length ? 'empty' : generated ? 'generated' : 'manual', items: lineup.length, cycleMs, findings, redirects: [...redirects].filter(Boolean) };
}

const ORDER: Record<FindingSeverity, number> = { error: 0, warning: 1, info: 2 };
export const sortFindings = (findings: Finding[]) => [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

/**
 * Redirect loops through `channelId`, from every channel's redirects known so
 * far (`edges`, channel → targets). When not every channel has been checked, a
 * channel that redirects says the loop check is partial rather than "no loop".
 */
export function loopFindings(channelId: string, edges: Map<string, string[]>, channelNames: Map<string, string>): Finding[] {
  const loop = findLoop(channelId, edges);
  if (loop) return [{ id: 'redirect-loop', severity: 'error', title: 'Redirects go round in a loop', detail: `${loop.map((id) => channelNames.get(id) ?? 'a channel that’s gone').join(' → ')}. A viewer sent round it never reaches a program.` }];
  const covered = [...channelNames.keys()].filter((id) => edges.has(id)).length;
  if ((edges.get(channelId) ?? []).length && covered < channelNames.size) {
    return [{ id: 'loop-coverage', severity: 'info', title: 'Redirect loops checked partly', detail: `${covered} of ${channelNames.size} channels have been checked, so a loop through the others wouldn’t show yet. Check all channels to be sure.` }];
  }
  return [];
}

/** Worst finding wins; info alone is healthy. */
export function healthStatus(findings: Finding[], error?: string): HealthStatus {
  if (error) return 'unknown';
  if (findings.some((finding) => finding.severity === 'error')) return 'error';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'healthy';
}
