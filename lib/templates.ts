// Programming templates: daypart grids modelled on how kinds of channels and
// well-known networks lay out their day. A template names roles ("Prime-time
// drama", "Morning news"); the user fills each role with a source, and the
// template becomes an ordinary time-slot schedule draft that is previewed and
// saved like any other. Network templates are approximations of a network's
// style, not official schedules, and carry no logos or branding.
import type { RuleSet } from '../server/smartCollection';
import { WEEKDAY_KEYS, type AdLevel, type AdStyle, type Block, type PlayOrder, type Template, type TemplateRole } from '../server/templateSchema';
import { changeSlotSource, DAY_MS, DEFAULT_SETTINGS, newSlotId, slotCanHaveCommercials, slotLabel, slotSourceKey, sortTimeSlots, type MidRoll, type ScheduleDraftState, type Slot, type SlotFiller, type SourceOption } from './schedule';
import type { RoleDefault, TemplateDays } from '../server/templateSchema';

export type { AdLevel, AdStyle, Block, Template, TemplateRole } from '../server/templateSchema';
export { AD_LEVELS } from '../server/templateSchema';

const MIN = 60_000;
const any = (field: string, ...values: string[]): RuleSet['rules'][number] => ({ field, op: 'is', values });
// Tunarr indexes TV genres on the show, not the episode, so episode suggestions
// match on the show's genre. Suggestions always name a playable type: smart
// collections play raw search results, and a "show" result can't air.
export const episodes = (...genres: string[]): RuleSet => ({ match: 'all', rules: [any('type', 'episode'), any('show_genre', ...genres)] });
export const movies = (...genres: string[]): RuleSet => ({ match: 'all', rules: genres.length ? [any('type', 'movie'), any('genre', ...genres)] : [any('type', 'movie')] });
export const videos = (...genres: string[]): RuleSet => ({ match: 'all', rules: genres.length ? [any('type', 'music_video', 'other_video', 'track'), any('genre', ...genres)] : [any('type', 'music_video', 'other_video', 'track')] });
const oldMovies: RuleSet = { match: 'all', rules: [any('type', 'movie'), { field: 'year', op: '<', value: 1980 }] };

/** Roles network templates share; templates pick them by id and may relabel them. */
const PRESETS: Record<string, Omit<TemplateRole, 'id'>> = {
  news: { label: 'News', hint: 'Newscasts', order: 'chronological', suggest: episodes('News') },
  morning: { label: 'Morning show', hint: 'Breakfast news and magazine', order: 'shuffle', suggest: episodes('News', 'Talk Show', 'Reality') },
  talk: { label: 'Talk & magazine', hint: 'Talk, magazine and gossip shows', order: 'shuffle', suggest: episodes('Talk Show', 'Reality') },
  daytime: { label: 'Daytime', hint: 'Talk, court and lifestyle shows', order: 'shuffle', suggest: episodes('Talk Show', 'Reality', 'Game Show') },
  game: { label: 'Game show', hint: 'Quiz and game shows', order: 'shuffle', suggest: episodes('Game Show') },
  soap: { label: 'Soap opera', hint: 'Daily soaps, in order', order: 'next', suggest: episodes('Soap', 'Drama') },
  novela: { label: 'Telenovela', hint: 'Telenovelas and soaps, in order', order: 'next', suggest: episodes('Soap', 'Telenovela', 'Romance', 'Drama') },
  sitcom: { label: 'Sitcoms', hint: 'Half-hour comedies', order: 'shuffle', suggest: episodes('Comedy') },
  drama: { label: 'Drama', hint: 'Drama series, in order', order: 'next', suggest: episodes('Drama') },
  procedural: { label: 'Crime & procedural', hint: 'Crime and mystery series', order: 'shuffle', suggest: episodes('Crime', 'Mystery', 'Thriller') },
  reality: { label: 'Reality & entertainment', hint: 'Reality competitions and entertainment', order: 'next', suggest: episodes('Reality') },
  variety: { label: 'Variety', hint: 'Variety and comedy shows', order: 'shuffle', suggest: episodes('Variety', 'Comedy', 'Game Show') },
  latenight: { label: 'Late-night talk', hint: 'Late-night talk and comedy', order: 'shuffle', suggest: episodes('Talk Show', 'Comedy') },
  movie: { label: 'Movie', hint: 'Feature films', order: 'shuffle', suggest: movies() },
  blockbuster: { label: 'Big movie', hint: 'Action, adventure and sci-fi films', order: 'shuffle', suggest: movies('Action', 'Adventure', 'Science Fiction', 'Thriller') },
  thriller: { label: 'Late thrillers', hint: 'Thrillers, horror and crime films', order: 'shuffle', suggest: movies('Thriller', 'Horror', 'Crime') },
  family: { label: 'Family movie', hint: 'Family and animated films', order: 'shuffle', suggest: movies('Family', 'Animation') },
  classic: { label: 'Classic films', hint: 'Films before 1980', order: 'shuffle', suggest: oldMovies },
  kids: { label: 'Kids', hint: 'Cartoons and kids shows', order: 'shuffle', suggest: episodes('Animation', 'Children', 'Kids', 'Family') },
  preschool: { label: 'Preschool', hint: 'Shows for the youngest', order: 'shuffle', suggest: episodes('Children', 'Kids') },
  cartoons: { label: 'Cartoons', hint: 'Animated series', order: 'shuffle', suggest: episodes('Animation') },
  adultanimation: { label: 'Late-night animation', hint: 'Animation for grown-ups', order: 'shuffle', suggest: episodes('Animation', 'Comedy') },
  anime: { label: 'Anime', hint: 'Anime series, in order', order: 'next', suggest: episodes('Anime', 'Animation') },
  sports: { label: 'Sports', hint: 'Games and sports programs', order: 'shuffle', suggest: episodes('Sport', 'Sports') },
  docs: { label: 'Documentary', hint: 'Documentaries', order: 'shuffle', suggest: episodes('Documentary') },
  lifestyle: { label: 'Lifestyle', hint: 'Cooking, travel, home and antiques', order: 'shuffle', suggest: episodes('Food', 'Travel', 'Reality', 'Home and Garden') },
  education: { label: 'Education', hint: 'Educational programs', order: 'shuffle', suggest: episodes('Documentary', 'Children', 'Education') },
  music: { label: 'Music', hint: 'Music programs and videos', order: 'shuffle', suggest: episodes('Music', 'Musical') },
  musicvideos: { label: 'Music videos', hint: 'Music videos', order: 'shuffle', suggest: videos() },
  history: { label: 'Period drama', hint: 'Historical and period drama, in order', order: 'next', suggest: episodes('History', 'War & Politics', 'Drama') },
  tokusatsu: { label: 'Kids heroes', hint: 'Tokusatsu and action shows for kids', order: 'next', suggest: episodes('Action & Adventure', 'Sci-Fi & Fantasy', 'Kids') },
  politics: { label: 'Politics & current affairs', hint: 'Political talk and debate', order: 'shuffle', suggest: episodes('News', 'Talk Show') },
  satire: { label: 'Satire & comedy news', hint: 'Satirical news and comedy panels', order: 'shuffle', suggest: episodes('Comedy', 'News') },
  court: { label: 'Court show', hint: 'Court and judge shows', order: 'shuffle', suggest: episodes('Reality', 'Talk Show') },
  investigative: { label: 'Investigative', hint: 'Investigative journalism and crime docs', order: 'shuffle', suggest: episodes('Documentary', 'Crime', 'News') },
};

export const PRESET_IDS = Object.keys(PRESETS);

/** A role from the presets, optionally relabelled. */
export const preset = (id: string, label?: string, hint?: string, order?: PlayOrder): TemplateRole => {
  const base = PRESETS[id];
  if (!base) throw new Error(`Unknown role preset ${id}`);
  return { id, ...base, ...(label ? { label } : {}), ...(hint ? { hint } : {}), ...(order ? { order } : {}) };
};

/** Commercial styles by market. */
export const AD_STYLES = {
  us: { label: 'US: a break about every 8 minutes, 3-minute pods, promos before shows', midRoll: { everyMin: 8, breakMin: 3, maxBreaks: 6, minProgramMin: 18 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  usSpanish: { label: 'US Spanish-language: breaks about every 10 minutes, 4-minute pods', midRoll: { everyMin: 10, breakMin: 4, maxBreaks: 5, minProgramMin: 18 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  ar: { label: 'Argentina: long “tandas” about every 12 minutes, 5-minute breaks', midRoll: { everyMin: 12, breakMin: 5, maxBreaks: 4, minProgramMin: 20 }, commercialsAt: ['mid', 'post'], promosAt: ['tail'] },
  arPublic: { label: 'Argentine public TV: few, short breaks', midRoll: { everyMin: 20, breakMin: 2, maxBreaks: 2, minProgramMin: 30 }, commercialsAt: ['mid'], promosAt: ['post', 'tail'] },
  jp: { label: 'Japan: short breaks about every 7 minutes, station spots between shows', midRoll: { everyMin: 7, breakMin: 2, maxBreaks: 6, minProgramMin: 20 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  es: { label: 'Spain: long breaks about every 15 minutes, up to 7 minutes', midRoll: { everyMin: 15, breakMin: 7, maxBreaks: 4, minProgramMin: 25 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  uk: { label: 'UK commercial TV: a break about every 13 minutes, 3½-minute breaks', midRoll: { everyMin: 13, breakMin: 3.5, maxBreaks: 4, minProgramMin: 20 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  itMediaset: { label: 'Italian commercial TV: breaks about every 12 minutes, 4-minute breaks', midRoll: { everyMin: 12, breakMin: 4, maxBreaks: 5, minProgramMin: 20 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  itRai: { label: 'Italian public TV: fewer, shorter breaks (about every 20 minutes)', midRoll: { everyMin: 20, breakMin: 2.5, maxBreaks: 3, minProgramMin: 30 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  kids: { label: 'Kids TV: a break about every 7 minutes, bumpers in and out', midRoll: { everyMin: 7, breakMin: 2.5, maxBreaks: 4, minProgramMin: 15 }, commercialsAt: ['mid', 'post'], promosAt: ['pre', 'post'] },
  news: { label: 'News channel: a break about every 9 minutes', midRoll: { everyMin: 9, breakMin: 3, maxBreaks: 5, minProgramMin: 20 }, commercialsAt: ['mid', 'post'], promosAt: ['pre'] },
  music: { label: 'Music TV: ad pods at the end of each block, station IDs at the start', commercialsAt: ['tail'], promosAt: ['head'] },
  publicService: { label: 'Public service: no commercials; promos and idents between programs', commercialsAt: [], promosAt: ['post', 'tail'] },
  promosOnly: { label: 'No commercials; promos and interstitials between programs', commercialsAt: [], promosAt: ['post'] },
  premium: { label: 'Premium: no commercials; trailers and promos fill up to the next start time', commercialsAt: [], promosAt: ['tail'] },
} satisfies Record<string, AdStyle>;

/** General templates with no network behind them. */
export const GENERAL_TEMPLATES: Template[] = [
  {
    id: 'general', name: 'General entertainment', inspiredBy: 'A typical general-entertainment channel', region: 'Anywhere',
    description: 'Kids in the morning, talk and lifestyle in the day, sitcoms around dinner, drama in prime time, a late movie, reruns overnight.',
    ads: AD_STYLES.us, padMs: 5 * MIN, latenessMs: 30 * MIN,
    roles: [preset('kids', 'Morning kids'), preset('daytime', 'Daytime talk & lifestyle'), preset('sitcom'), preset('drama', 'Prime-time drama', 'Hour-long dramas, in order'), preset('movie', 'Late movie')],
    days: { all: [['06:00', 'kids'], ['09:00', 'daytime'], ['12:00', 'sitcom'], ['14:00', 'drama'], ['17:00', 'daytime'], ['18:00', 'sitcom'], ['20:00', 'drama', 'heavy'], ['22:00', 'movie'], ['00:30', 'sitcom', 'light'], ['02:00', 'drama', 'light']] },
  },
  {
    id: 'kids', name: 'Kids & cartoons', inspiredBy: 'A typical kids channel', region: 'Anywhere',
    description: 'Preschool shows early, cartoons through the day, a family movie at 19:00, then animation for grown-ups overnight.',
    ads: AD_STYLES.kids, padMs: 15 * MIN, latenessMs: 15 * MIN,
    roles: [preset('preschool'), preset('cartoons'), preset('family'), preset('adultanimation')],
    days: { all: [['06:00', 'preschool', 'light'], ['09:00', 'cartoons'], ['19:00', 'family'], ['21:00', 'adultanimation']] },
  },
  {
    id: 'movies', name: 'Movie channel', inspiredBy: 'A typical movie channel', region: 'Anywhere',
    description: 'Films all day from the half hour: family films in the morning, a big film at 20:00, thrillers late, classics overnight.',
    ads: AD_STYLES.premium, padMs: 30 * MIN, latenessMs: 30 * MIN,
    roles: [preset('family'), preset('movie'), preset('blockbuster'), preset('thriller'), preset('classic')],
    days: { all: [['06:00', 'family'], ['10:00', 'movie'], ['20:00', 'blockbuster'], ['22:30', 'thriller'], ['02:00', 'classic']] },
  },
  {
    id: 'music', name: 'Music video channel', inspiredBy: 'A typical music video channel', region: 'Anywhere',
    description: 'Blocks of music videos: hits by day, a countdown in the afternoon, rock at night, slow and chill late; ad pods at the end of each block.',
    ads: AD_STYLES.music, padMs: 1, latenessMs: 15 * MIN,
    roles: [
      { id: 'hits', label: 'Hits', hint: 'Popular music videos', order: 'shuffle', suggest: videos() },
      { id: 'countdown', label: 'Countdown', hint: 'Music videos, newest first', order: 'chronological', suggest: videos() },
      { id: 'rock', label: 'Rock & alternative', hint: 'Rock videos', order: 'shuffle', suggest: videos('Rock', 'Alternative', 'Metal') },
      { id: 'chill', label: 'Late-night chill', hint: 'Slow and ambient videos', order: 'shuffle', suggest: videos('Ambient', 'Jazz', 'R&B', 'Soul', 'Electronic') },
    ],
    days: { all: [['06:00', 'hits'], ['15:00', 'countdown'], ['17:00', 'hits'], ['21:00', 'rock'], ['00:00', 'chill', 'light'], ['03:00', 'hits', 'none']] },
  },
  {
    id: 'news', name: '24-hour news', inspiredBy: 'A typical rolling-news channel', region: 'Anywhere',
    description: 'News on the hour around the clock, current affairs at midday and evening, documentaries overnight.',
    ads: AD_STYLES.news, padMs: 30 * MIN, latenessMs: 15 * MIN,
    roles: [preset('news'), preset('politics', 'Current affairs'), preset('docs')],
    days: { all: [['05:00', 'news'], ['12:00', 'politics'], ['14:00', 'news'], ['20:00', 'docs'], ['21:00', 'politics', 'heavy'], ['22:00', 'news'], ['01:00', 'docs', 'light']] },
  },
];

const clock = (value: string) => {
  const [hours, minutes] = value.split(':').map(Number);
  return (hours * 60 + minutes) * MIN;
};

export const isWeekly = (template: Pick<Template, 'days'>) => !('all' in template.days);

/** The blocks of each day of the week. Tunarr's weekly schedules start on Sunday (day 0). */
export function weekGrid(template: Pick<Template, 'days'>): Block[][] {
  const { days } = template;
  if ('all' in days) return Array.from({ length: 7 }, () => days.all);
  return WEEKDAY_KEYS.map((key) => (key === 'sunday' ? days.sunday : key === 'saturday' ? days.saturday : (days as Record<string, Block[] | undefined>)[key] ?? days.weekdays));
}

/** Day rows to show: one for daily templates; weekdays, any single-day overrides, Saturday and Sunday for weekly ones. */
export function dayRows(template: Pick<Template, 'days'>): Array<{ label: string; key: string; blocks: Block[] }> {
  const { days } = template;
  if ('all' in days) return [{ label: 'Every day', key: 'all', blocks: days.all }];
  const overrides = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).filter((key) => days[key]);
  return [
    { label: overrides.length ? 'Other weekdays' : 'Mon–Fri', key: 'weekdays', blocks: days.weekdays },
    ...overrides.map((key) => ({ label: key[0].toUpperCase() + key.slice(1), key, blocks: days[key]! })),
    { label: 'Saturday', key: 'saturday', blocks: days.saturday },
    { label: 'Sunday', key: 'sunday', blocks: days.sunday },
  ];
}

/** A day's blocks as [start, end) offsets (ms from midnight) with their role, wrapping past midnight. */
export function daySegments(blocks: Block[]) {
  const starts = blocks.map(([at, roleId, level]) => ({ start: clock(at), roleId, level: (level ?? 'standard') as AdLevel })).sort((a, b) => a.start - b.start);
  return starts.map((block, index) => ({ ...block, end: index + 1 < starts.length ? starts[index + 1].start : starts[0].start + DAY_MS }));
}

export type TemplateLists = { commercials?: string; promos?: string };

/** Mid-roll settings for an ad level: light spaces breaks out, heavy brings them closer and makes them longer. */
export function midRollFor(style: AdStyle, level: AdLevel) {
  const mid = style.midRoll;
  if (!mid || level === 'none') return undefined;
  const scale = level === 'light' ? { every: 1.6, length: 0.75, max: -2 } : level === 'heavy' ? { every: 0.75, length: 1.25, max: 1 } : { every: 1, length: 1, max: 0 };
  return {
    breakRule: { type: 'fixed_interval', intervalMs: Math.max(2, Math.round(mid.everyMin * scale.every)) * MIN },
    breakDurationMs: Math.max(1, Math.round(mid.breakMin * scale.length * 2)) * (MIN / 2),
    maxBreaks: Math.max(1, mid.maxBreaks + scale.max),
    minProgramDurationMs: mid.minProgramMin * MIN,
    strategy: 'eager',
  };
}

/**
 * Builds a time-slot schedule draft. Blocks whose role has no source are left
 * out, so the previous block runs on. Every slot that can carry commercials
 * gets the template's ad style at the block's level, with the chosen lists.
 */
export function templateToDraft(template: Template, sources: Record<string, SourceOption | undefined>, lists: TemplateLists): ScheduleDraftState {
  const weekly = isWeekly(template);
  const grids = weekly ? weekGrid(template) : [weekGrid(template)[0]];
  const roles = new Map(template.roles.map((item) => [item.id, item]));
  const slots: Slot[] = [];
  grids.forEach((blocks, day) => {
    for (const [at, roleId, level = 'standard'] of blocks) {
      const source = sources[roleId];
      if (!source) continue;
      const slot = changeSlotSource({ type: 'flex' }, source);
      if (typeof slot.order === 'string') slot.order = roles.get(roleId)?.order ?? slot.order;
      if ('id' in slot) slot.id = newSlotId();
      slot.startTime = day * DAY_MS + clock(at);
      if (slotCanHaveCommercials(slot)) {
        const commercials = level !== 'none' && !!lists.commercials && template.ads.commercialsAt.length > 0;
        const filler = [
          ...(commercials ? [{ types: template.ads.commercialsAt, fillerListId: lists.commercials!, fillerOrder: 'shuffle_prefer_short' }] : []),
          ...(lists.promos && template.ads.promosAt.length ? [{ types: template.ads.promosAt, fillerListId: lists.promos, fillerOrder: 'shuffle_prefer_short' }] : []),
        ];
        if (filler.length) slot.filler = filler;
        const midRoll = commercials ? midRollFor(template.ads, level) : undefined;
        if (midRoll) slot.midRoll = midRoll;
      }
      slots.push(slot);
    }
  });
  return {
    type: 'time',
    settings: { ...DEFAULT_SETTINGS.time, period: weekly ? 'week' : 'day', padMs: template.padMs, latenessMs: template.latenessMs, flexPreference: 'end', overflow: { type: 'duration', maxMs: 0 } },
    slots: sortTimeSlots(slots),
    extraMovies: [],
  };
}

/** Roles a template actually schedules, with how many blocks each fills per week (or day). */
export function roleUsage(template: Pick<Template, 'days'>) {
  const counts = new Map<string, number>();
  for (const blocks of isWeekly(template) ? weekGrid(template) : [weekGrid(template)[0]]) for (const [, roleId] of blocks) counts.set(roleId, (counts.get(roleId) ?? 0) + 1);
  return counts;
}

/** The slot source a role default stands for. */
export const defaultSource = (value: RoleDefault): SourceOption => ({ key: value.key, label: value.label, template: value.template as Slot });

const PAD_VALUES = [1, 5, 10, 15, 30, 60].map((minutes) => (minutes === 1 ? 1 : minutes * MIN));
const hhmm = (offset: number) => {
  const minutes = Math.floor((offset % DAY_MS) / MIN);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const sameBlocks = (a: Block[], b: Block[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A template from a channel's time-slot schedule, so its format can be reused
 * on other channels. Each source becomes a role pre-filled with that source;
 * flex slots are left out. Random-slot schedules have no clock times, so they
 * can't become templates.
 */
export function scheduleToTemplate(draft: ScheduleDraftState, name: string, description = ''): Omit<Template, 'id'> | null {
  if (draft.type !== 'time') return null;
  const roles: TemplateRole[] = [];
  const defaults: Record<string, RoleDefault> = {};
  const roleOf = new Map<string, string>();
  const midSlot = draft.slots.find((slot) => slot.midRoll);
  const fillerSlot = draft.slots.find((slot) => Array.isArray(slot.filler) && (slot.filler as SlotFiller[]).length);
  const fillers = (fillerSlot?.filler as SlotFiller[] | undefined) ?? [];
  const mid = midSlot?.midRoll as MidRoll | undefined;
  const ads: AdStyle = {
    label: mid ? 'From this channel: breaks inside programs' : fillers.length ? 'From this channel: filler between programs' : 'From this channel: no commercials',
    commercialsAt: fillers[0]?.types ?? [],
    promosAt: fillers[1]?.types ?? [],
    ...(mid ? { midRoll: { everyMin: Math.max(2, Math.round((mid.breakRule?.intervalMs ?? mid.intervalMs ?? 10 * MIN) / MIN)), breakMin: Math.max(0.5, (mid.breakDurationMs ?? 2 * MIN) / MIN), maxBreaks: Math.max(1, mid.maxBreaks), minProgramMin: Math.round((mid.minProgramDurationMs ?? 0) / MIN) } } : {}),
  };
  const days: Block[][] = Array.from({ length: 7 }, () => []);
  for (const slot of sortTimeSlots(draft.slots)) {
    const key = slotSourceKey(slot);
    if (!key || key === 'flex') continue;
    let roleId = roleOf.get(key);
    if (!roleId) {
      roleId = `r${roles.length + 1}`;
      roleOf.set(key, roleId);
      roles.push({ id: roleId, label: slotLabel(slot).slice(0, 80), hint: '', order: (typeof slot.order === 'string' ? slot.order : 'shuffle') as TemplateRole['order'] });
      const template: Slot = { ...slot };
      for (const field of ['id', 'startTime', 'filler', 'midRoll', 'iterationGroup', 'linkMode', 'rerunOverflow', 'weight', 'cooldownMs', 'durationSpec', 'index']) delete template[field];
      defaults[roleId] = { key, label: slotLabel(slot), template: template as RoleDefault['template'] };
    }
    const quiet = (ads.commercialsAt.length || ads.midRoll) && !slot.midRoll && !(Array.isArray(slot.filler) && (slot.filler as SlotFiller[]).length);
    const start = Number(slot.startTime);
    const block: Block = quiet ? [hhmm(start), roleId, 'none'] : [hhmm(start), roleId];
    if (draft.settings.period === 'week') days[Math.floor(start / DAY_MS) % 7].push(block);
    else days[0].push(block);
  }
  if (!roles.length) return null;
  let templateDays: TemplateDays;
  if (draft.settings.period !== 'week') templateDays = { all: days[0] };
  else {
    const week: Record<string, Block[]> = { weekdays: days[1], saturday: days[6], sunday: days[0] };
    (['tuesday', 'wednesday', 'thursday', 'friday'] as const).forEach((key, index) => { if (!sameBlocks(days[index + 2], days[1])) week[key] = days[index + 2]; });
    templateDays = week as TemplateDays;
  }
  const padMs = PAD_VALUES.includes(Number(draft.settings.padMs)) ? Number(draft.settings.padMs) : 1;
  return {
    name, description, inspiredBy: 'Saved from a channel', region: 'Anywhere', ads, padMs,
    latenessMs: Number(draft.settings.latenessMs) || 0, roles, days: templateDays, defaults,
  };
}

/** A new, empty template for the editor. */
export const blankTemplate = (): Omit<Template, 'id'> => ({
  name: '', description: '', inspiredBy: 'My own format', region: 'Anywhere', ads: AD_STYLES.us, padMs: 5 * MIN, latenessMs: 20 * MIN,
  roles: [preset('news'), preset('drama', 'Prime-time drama')],
  days: { all: [['06:00', 'news'], ['20:00', 'drama', 'heavy']] },
});
