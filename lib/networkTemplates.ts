// Templates inspired by the mainstream channels of Japan, Argentina, the
// United States, Spain, the United Kingdom and Italy. Each is a simplified
// daypart plan in the network's style (the kinds of programs it airs and
// roughly when, and its commercial pattern), not its official schedule. Times
// are local to the channel. Network names appear only as "Inspired by" text.
import type { Block, Template, TemplateDays, TemplateRole } from '../server/templateSchema';
import { AD_STYLES, preset } from './templates';

const MIN = 60_000;

/** A copy of `base` with blocks at the same times replaced and new ones added. */
const patch = (base: Block[], changes: Block[]): Block[] => {
  const times = new Set(changes.map(([at]) => at));
  return [...base.filter(([at]) => !times.has(at)), ...changes].sort((a, b) => a[0].localeCompare(b[0]));
};

/** A preset role under its own id, for a second role of the same kind in one template. */
const named = (id: string, role: TemplateRole): TemplateRole => ({ ...role, id });

type Spec = {
  id: string; name: string; network: string; region: string; description: string;
  ads: Template['ads']; pad?: number; late?: number; roles: TemplateRole[]; days: TemplateDays;
};

const net = ({ id, name, network, region, description, ads, pad = 1, late = 20, roles, days }: Spec): Template => ({
  id, name, inspiredBy: `Inspired by ${network}`, region, description, ads,
  padMs: pad === 1 ? 1 : pad * MIN, latenessMs: late * MIN, roles, days,
});

// ------------------------------------------------------------------- Japan

const JP = 'Japan';
const jpWeekday = (prime: Block[]): Block[] => [['04:55', 'news'], ['08:00', 'talk'], ['10:30', 'procedural', 'light'], ['11:50', 'talk'], ['13:50', 'procedural', 'light'], ['15:45', 'news'], ['19:00', 'variety'], ...prime, ['23:00', 'news'], ['23:40', 'variety'], ['00:30', 'anime'], ['02:00', 'procedural', 'light']];

const japan: Template[] = [
  net({
    id: 'jp-nhk-g', name: 'NHK General TV', network: 'NHK General TV programming', region: JP,
    description: 'No commercials. News through the morning, the morning serial drama at 08:00, information programs, news at noon, 19:00 and 21:00, documentaries in the evening and the Sunday 20:00 historical drama.',
    ads: AD_STYLES.publicService, pad: 5, late: 15,
    roles: [preset('news'), preset('drama', 'Morning drama', 'A serial drama, one episode a day'), preset('lifestyle', 'Information & lifestyle'), preset('docs'), preset('music', 'Culture & music'), preset('history', 'Historical drama', 'A period drama, in order (Sunday 20:00)')],
    days: {
      weekdays: [['04:30', 'news'], ['08:00', 'drama'], ['08:15', 'lifestyle'], ['12:00', 'news'], ['12:45', 'drama'], ['13:05', 'lifestyle'], ['18:00', 'news'], ['19:30', 'docs'], ['21:00', 'news'], ['22:00', 'docs'], ['23:00', 'music'], ['00:00', 'news'], ['01:00', 'docs']],
      saturday: [['05:00', 'news'], ['08:00', 'drama'], ['08:15', 'lifestyle'], ['12:00', 'news'], ['13:00', 'music'], ['18:00', 'news'], ['19:30', 'docs'], ['21:00', 'news'], ['22:00', 'music'], ['00:00', 'news'], ['01:00', 'docs']],
      sunday: [['05:00', 'news'], ['08:00', 'lifestyle'], ['12:00', 'news'], ['13:00', 'music'], ['18:00', 'news'], ['19:30', 'docs'], ['20:00', 'history'], ['21:00', 'docs'], ['22:00', 'music'], ['00:00', 'news'], ['01:00', 'docs']],
    },
  }),
  net({
    id: 'jp-nhk-e', name: 'NHK Educational TV', network: 'NHK E-tele (Educational TV) programming', region: JP,
    description: 'No commercials. Preschool shows in the morning and late afternoon, school programs by day, anime for kids at 18:00, hobby and language lessons in the evening, culture late.',
    ads: AD_STYLES.publicService, pad: 5, late: 10,
    roles: [preset('preschool'), preset('education', 'School programs'), preset('anime', 'Kids anime'), preset('lifestyle', 'Hobbies & lessons'), preset('docs', 'Culture & science'), preset('music', 'Classical & music')],
    days: {
      weekdays: [['06:00', 'preschool'], ['09:00', 'education'], ['15:00', 'preschool'], ['18:00', 'anime'], ['19:00', 'lifestyle'], ['21:00', 'docs'], ['23:00', 'music'], ['00:00', 'education']],
      saturday: [['06:00', 'preschool'], ['09:00', 'lifestyle'], ['17:00', 'anime'], ['19:00', 'docs'], ['21:00', 'music'], ['23:00', 'lifestyle']],
      sunday: [['06:00', 'preschool'], ['09:00', 'lifestyle'], ['17:00', 'anime'], ['19:00', 'docs'], ['21:00', 'music'], ['23:00', 'docs']],
    },
  }),
  net({
    id: 'jp-ntv', name: 'Nippon TV', network: 'Nippon TV programming', region: JP,
    description: 'Early news, the morning info show, the live noon variety show, evening news, variety at 19:00, a 22:00 drama, the late news, and the Friday 21:00 movie roadshow; Saturday-evening anime and the Sunday 17:30 comedy show.',
    ads: AD_STYLES.jp,
    roles: [preset('news'), preset('morning', 'Morning info show'), preset('talk', 'Wide show'), preset('variety'), preset('drama'), preset('procedural', 'Drama reruns'), preset('movie', 'Friday Roadshow'), preset('anime'), preset('sports')],
    days: {
      weekdays: jpWeekday([['22:00', 'drama', 'heavy']]).map((block): Block => (block[0] === '04:55' ? ['04:00', 'news'] : block[0] === '08:00' ? ['05:50', 'morning'] : block)),
      friday: patch(jpWeekday([['22:00', 'drama', 'heavy']]).map((block): Block => (block[0] === '04:55' ? ['04:00', 'news'] : block[0] === '08:00' ? ['05:50', 'morning'] : block)), [['21:00', 'movie', 'light']]),
      saturday: [['05:30', 'news'], ['08:00', 'talk'], ['12:00', 'variety'], ['17:30', 'anime'], ['19:00', 'variety'], ['21:00', 'drama', 'heavy'], ['23:00', 'news'], ['23:30', 'variety'], ['01:00', 'anime']],
      sunday: [['06:00', 'news'], ['08:00', 'talk'], ['12:00', 'sports'], ['17:30', 'variety'], ['19:00', 'variety'], ['22:30', 'drama'], ['23:30', 'news'], ['00:30', 'anime']],
    },
  }),
  net({
    id: 'jp-tbs', name: 'TBS Television', network: 'TBS Television programming', region: JP,
    description: 'Morning news, the morning and noon wide shows, evening news, variety at 19:00, dramas at 22:00 on weekdays and the big Sunday 21:00 drama; late news and late-night variety.',
    ads: AD_STYLES.jp,
    roles: [preset('news'), preset('talk', 'Wide show'), preset('procedural', 'Drama reruns'), preset('variety'), preset('drama'), preset('anime'), preset('sports')],
    days: {
      weekdays: jpWeekday([['22:00', 'drama', 'heavy']]),
      saturday: [['05:30', 'news'], ['08:00', 'talk'], ['12:00', 'variety'], ['17:30', 'anime'], ['19:00', 'variety'], ['22:00', 'drama', 'heavy'], ['23:30', 'news'], ['00:00', 'anime']],
      sunday: [['06:00', 'news'], ['08:00', 'talk'], ['12:00', 'sports'], ['18:00', 'news'], ['19:00', 'variety'], ['21:00', 'drama', 'heavy'], ['22:00', 'variety'], ['23:00', 'news'], ['00:00', 'anime']],
    },
  }),
  net({
    id: 'jp-fuji', name: 'Fuji TV', network: 'Fuji TV programming', region: JP,
    description: 'The early-morning news show, morning and noon wide shows, afternoon drama reruns, evening news, variety at 19:00, the Monday 21:00 drama, late news and late-night anime; Sunday-morning anime and the classic Sunday 18:00 family cartoons.',
    ads: AD_STYLES.jp,
    roles: [preset('news'), preset('talk', 'Wide show'), preset('procedural', 'Drama reruns'), preset('variety'), preset('drama', 'Monday drama'), preset('anime'), preset('cartoons', 'Family cartoons'), preset('sports')],
    days: {
      weekdays: jpWeekday([['22:00', 'drama', 'heavy']]),
      monday: patch(jpWeekday([['22:00', 'drama', 'heavy']]), [['21:00', 'drama', 'heavy']]),
      saturday: [['05:30', 'news'], ['08:00', 'talk'], ['12:00', 'variety'], ['16:30', 'sports'], ['19:00', 'variety'], ['21:00', 'drama', 'heavy'], ['23:00', 'news'], ['23:40', 'variety'], ['01:00', 'anime']],
      sunday: [['06:00', 'news'], ['09:00', 'anime'], ['10:00', 'talk'], ['12:00', 'sports'], ['18:00', 'cartoons'], ['19:00', 'variety'], ['21:00', 'drama', 'heavy'], ['23:00', 'news'], ['00:00', 'anime']],
    },
  }),
  net({
    id: 'jp-tv-asahi', name: 'TV Asahi', network: 'TV Asahi programming', region: JP,
    description: 'Early news, the morning wide show, detective-drama reruns in the afternoon, evening news, variety at 19:00, a 21:00 drama, the 21:54 news, late-night variety and anime; Saturday-evening family anime and Sunday-morning kids hero time.',
    ads: AD_STYLES.jp,
    roles: [preset('news'), preset('talk', 'Wide show'), preset('procedural', 'Drama reruns'), preset('variety'), preset('drama', 'Prime drama'), preset('anime'), preset('tokusatsu'), preset('movie', 'Weekend movie')],
    days: {
      weekdays: [['04:55', 'news'], ['08:00', 'talk'], ['10:25', 'procedural', 'light'], ['13:00', 'talk'], ['15:45', 'news'], ['19:00', 'variety'], ['21:00', 'drama', 'heavy'], ['21:54', 'news'], ['23:15', 'variety'], ['00:15', 'anime'], ['01:30', 'procedural', 'light']],
      saturday: [['05:00', 'news'], ['08:00', 'talk'], ['12:00', 'variety'], ['16:30', 'anime'], ['18:00', 'news'], ['19:00', 'variety'], ['21:00', 'movie'], ['23:30', 'anime'], ['01:30', 'procedural', 'light']],
      sunday: [['05:00', 'news'], ['08:30', 'tokusatsu'], ['10:00', 'talk'], ['12:00', 'variety'], ['18:00', 'news'], ['19:00', 'variety'], ['21:00', 'movie'], ['23:30', 'anime'], ['01:30', 'procedural', 'light']],
    },
  }),
  net({
    id: 'jp-tv-tokyo', name: 'TV Tokyo', network: 'TV Tokyo programming', region: JP,
    description: 'Business news at dawn, a kids variety show before school, travel and shopping by day, the weekday afternoon movie, anime at 18:00, travel and variety in prime time, the 22:00 business news and late-night dramas and anime.',
    ads: AD_STYLES.jp,
    roles: [preset('news', 'Business news'), preset('kids', 'Morning kids'), preset('lifestyle', 'Travel & shopping'), preset('movie', 'Afternoon roadshow'), preset('anime'), preset('variety', 'Travel & variety'), preset('drama', 'Late-night drama')],
    days: {
      weekdays: [['05:45', 'news'], ['07:05', 'kids'], ['08:00', 'lifestyle', 'light'], ['13:40', 'movie'], ['16:00', 'lifestyle'], ['18:00', 'anime'], ['19:00', 'variety'], ['22:00', 'news'], ['23:00', 'drama'], ['00:00', 'anime']],
      saturday: [['06:00', 'kids'], ['08:00', 'anime'], ['10:00', 'lifestyle'], ['16:00', 'movie'], ['18:00', 'variety'], ['21:00', 'drama'], ['23:00', 'anime']],
      sunday: [['06:00', 'kids'], ['07:30', 'anime'], ['10:00', 'lifestyle'], ['13:00', 'movie'], ['17:30', 'anime'], ['19:00', 'variety'], ['22:00', 'news'], ['23:00', 'anime']],
    },
  }),
];

// --------------------------------------------------------------- Argentina

const AR = 'Argentina';
const argentina: Template[] = [
  net({
    id: 'ar-telefe', name: 'Telefe', network: 'Telefe programming', region: AR,
    description: 'Morning news and magazine, the noon newscast, afternoon telenovelas and talk, a game show before the 20:00 news, then the big prime-time show; movies and a family show at weekends.',
    ads: AD_STYLES.ar, pad: 5, late: 30,
    roles: [preset('news', 'Noticiero'), preset('talk', 'Magazine & talk'), preset('novela'), preset('game'), preset('reality', 'Prime-time show'), preset('kids', 'Weekend kids'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['13:00', 'news'], ['14:15', 'novela'], ['16:30', 'talk'], ['19:00', 'game'], ['20:00', 'news'], ['21:15', 'reality', 'heavy'], ['22:30', 'novela'], ['00:00', 'talk'], ['01:30', 'movie', 'light']],
      saturday: [['07:00', 'kids'], ['10:00', 'talk'], ['13:00', 'news'], ['14:00', 'movie'], ['20:00', 'news'], ['21:00', 'reality', 'heavy'], ['23:00', 'movie']],
      sunday: [['07:00', 'kids'], ['10:00', 'talk'], ['13:00', 'news'], ['14:00', 'movie'], ['20:00', 'news'], ['21:00', 'reality', 'heavy'], ['23:00', 'movie']],
    },
  }),
  net({
    id: 'ar-eltrece', name: 'El Trece', network: 'El Trece (Canal 13) programming', region: AR,
    description: 'Morning news, magazines and talk, the midday news, afternoon novelas, a game show, the 20:00 newscast and prime-time entertainment and fiction; the famous Saturday-night dinner talk show and Sunday lunch talk.',
    ads: AD_STYLES.ar, pad: 5, late: 30,
    roles: [preset('news', 'Noticiero'), preset('talk', 'Magazine & talk'), preset('novela'), preset('game'), preset('reality', 'Prime-time entertainment'), preset('drama', 'Ficción'), preset('latenight', 'Dinner talk show'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['13:00', 'news'], ['14:00', 'talk'], ['16:00', 'novela'], ['19:00', 'game'], ['20:00', 'news'], ['21:30', 'reality', 'heavy'], ['22:30', 'drama'], ['00:00', 'talk', 'light']],
      saturday: [['08:00', 'talk'], ['13:00', 'news'], ['14:00', 'movie'], ['20:00', 'news'], ['21:30', 'latenight', 'heavy'], ['00:00', 'movie']],
      sunday: [['08:00', 'talk'], ['13:30', 'latenight'], ['16:00', 'movie'], ['20:00', 'news'], ['21:00', 'reality', 'heavy'], ['23:30', 'movie']],
    },
  }),
  net({
    id: 'ar-tvpublica', name: 'TV Pública', network: 'TV Pública (Canal 7) programming', region: AR,
    description: 'The public channel: news in the morning, at midday and at 21:00, culture and documentaries, kids programs, Argentine films in the afternoon and sports at weekends; few commercials.',
    ads: AD_STYLES.arPublic, pad: 5, late: 15,
    roles: [preset('news', 'Noticiero'), preset('talk', 'Magazine'), preset('kids'), preset('docs', 'Cultura & documentales'), preset('movie', 'Cine argentino'), preset('sports'), preset('music', 'Música')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['12:00', 'kids'], ['14:00', 'news'], ['15:00', 'movie'], ['17:00', 'docs'], ['21:00', 'news'], ['22:00', 'docs'], ['23:30', 'music'], ['00:30', 'movie']],
      saturday: [['07:00', 'kids'], ['10:00', 'docs'], ['13:00', 'sports'], ['18:00', 'movie'], ['21:00', 'news'], ['22:00', 'music'], ['00:00', 'movie']],
      sunday: [['07:00', 'kids'], ['10:00', 'docs'], ['13:00', 'sports'], ['18:00', 'movie'], ['21:00', 'news'], ['22:00', 'docs'], ['00:00', 'movie']],
    },
  }),
  net({
    id: 'ar-america', name: 'América TV', network: 'América TV programming', region: AR,
    description: 'News-heavy: morning news, talk and gossip shows through the day, the evening news, political talk in prime time and late-night talk.',
    ads: AD_STYLES.ar, pad: 5, late: 30,
    roles: [preset('news', 'Noticiero'), preset('talk', 'Talk & gossip'), preset('politics', 'Political talk'), preset('latenight'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['13:00', 'news'], ['14:00', 'talk'], ['19:00', 'news'], ['21:00', 'politics', 'heavy'], ['23:00', 'latenight'], ['01:00', 'news', 'light']],
      saturday: [['08:00', 'news'], ['10:00', 'talk'], ['14:00', 'movie'], ['20:00', 'news'], ['21:00', 'politics'], ['23:00', 'movie']],
      sunday: [['08:00', 'news'], ['10:00', 'talk'], ['14:00', 'movie'], ['20:00', 'news'], ['21:00', 'politics'], ['23:00', 'movie']],
    },
  }),
  net({
    id: 'ar-elnueve', name: 'El Nueve', network: 'El Nueve (Canal 9) programming', region: AR,
    description: 'Newscasts at midday, evening and late night, imported telenovelas through the afternoon, the comedy panel show in prime time and talk late.',
    ads: AD_STYLES.ar, pad: 5, late: 30,
    roles: [preset('news', 'Noticiero'), preset('talk', 'Magazine'), preset('novela'), preset('satire', 'Comedy panel'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['12:00', 'news'], ['13:30', 'novela'], ['19:00', 'news'], ['20:00', 'novela'], ['22:00', 'satire', 'heavy'], ['23:30', 'news'], ['00:30', 'novela', 'light']],
      saturday: [['08:00', 'talk'], ['12:00', 'news'], ['13:00', 'movie'], ['19:00', 'news'], ['20:00', 'novela'], ['22:00', 'movie']],
      sunday: [['08:00', 'talk'], ['12:00', 'news'], ['13:00', 'movie'], ['19:00', 'news'], ['20:00', 'novela'], ['22:00', 'movie']],
    },
  }),
  net({
    id: 'ar-tn', name: 'TN (Todo Noticias)', network: 'TN (Todo Noticias) programming', region: AR,
    description: 'Argentine 24-hour news: newscasts around the clock, political talk in the evening, interviews and documentaries at weekends.',
    ads: AD_STYLES.ar, pad: 30, late: 15,
    roles: [preset('news', 'Noticias'), preset('politics', 'Política'), preset('docs', 'Informes especiales')],
    days: {
      weekdays: [['05:00', 'news'], ['20:00', 'politics', 'heavy'], ['23:00', 'news'], ['02:00', 'docs', 'light']],
      saturday: [['06:00', 'news'], ['14:00', 'docs'], ['18:00', 'news'], ['21:00', 'politics'], ['00:00', 'news', 'light']],
      sunday: [['06:00', 'news'], ['14:00', 'docs'], ['18:00', 'news'], ['21:00', 'politics'], ['00:00', 'news', 'light']],
    },
  }),
];

// ----------------------------------------------------------- United States

const US = 'United States';
const usWeekday = (morning: string, daytime: Block[], prime: Block[], late: Block[]): Block[] =>
  [['05:00', 'news'], ['07:00', morning], ...daytime, ['17:00', 'news'], ['19:00', 'game'], ...prime, ['23:00', 'news'], ...late];

const unitedStates: Template[] = [
  net({
    id: 'us-abc', name: 'ABC', network: 'ABC network programming', region: US,
    description: 'Good-morning news at 07:00, a daytime talk panel and a long-running soap, local and network news, game shows in access, comedies and dramas in prime time, late-night talk and a late news magazine; college football on Saturday nights.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('news'), preset('morning', 'Morning show'), preset('daytime', 'Syndication'), preset('talk', 'Daytime talk panel'), preset('soap'), preset('game', 'Access game shows'), preset('sitcom', 'Prime comedies'), preset('drama', 'Prime drama'), preset('latenight'), preset('sports'), preset('reality', 'Family entertainment')],
    days: {
      weekdays: usWeekday('morning', [['09:00', 'daytime'], ['11:00', 'talk'], ['12:00', 'news'], ['13:00', 'daytime'], ['14:00', 'soap']], [['20:00', 'sitcom', 'heavy'], ['21:00', 'drama', 'heavy']], [['23:35', 'latenight'], ['01:00', 'daytime', 'light']]),
      saturday: [['07:00', 'morning'], ['09:00', 'daytime'], ['12:00', 'sports'], ['18:30', 'news'], ['19:00', 'game'], ['20:00', 'sports', 'heavy'], ['23:30', 'news'], ['00:00', 'daytime', 'light']],
      sunday: [['07:00', 'morning'], ['09:00', 'news'], ['11:00', 'daytime'], ['18:30', 'news'], ['19:00', 'reality'], ['20:00', 'reality', 'heavy'], ['22:00', 'drama'], ['23:00', 'news'], ['23:35', 'daytime', 'light']],
    },
  }),
  net({
    id: 'us-cbs', name: 'CBS', network: 'CBS network programming', region: US,
    description: 'A morning news show, the long-running price game show and two daytime soaps, evening news, game shows in access, sitcoms then procedurals in prime time, late-night talk; NFL football Sunday afternoons and the Sunday 19:00 news magazine.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('news'), preset('morning', 'Morning news'), preset('game'), preset('soap', 'Daytime soaps'), preset('daytime', 'Syndication'), preset('sitcom'), preset('procedural'), preset('latenight'), preset('sports', 'NFL & sports'), preset('investigative', 'News magazine')],
    days: {
      weekdays: usWeekday('morning', [['09:00', 'daytime'], ['10:00', 'game'], ['12:00', 'soap'], ['14:00', 'daytime']], [['20:00', 'sitcom', 'heavy'], ['21:00', 'procedural', 'heavy']], [['23:35', 'latenight'], ['00:37', 'latenight', 'light'], ['01:40', 'daytime', 'light']]),
      saturday: [['07:00', 'morning'], ['09:00', 'daytime'], ['12:00', 'sports'], ['18:30', 'news'], ['19:00', 'game'], ['20:00', 'procedural'], ['23:00', 'news'], ['23:30', 'daytime', 'light']],
      sunday: [['07:00', 'morning'], ['10:30', 'news'], ['13:00', 'sports', 'heavy'], ['19:00', 'investigative'], ['20:00', 'procedural', 'heavy'], ['23:00', 'news'], ['23:30', 'daytime', 'light']],
    },
  }),
  net({
    id: 'us-nbc', name: 'NBC', network: 'NBC network programming', region: US,
    description: 'The long morning news show, talk and syndication, evening news, game shows in access, dramas in prime time, the Tonight-style talk show and later talk; the Saturday 23:30 sketch comedy and Sunday-night football.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('news'), preset('morning', 'Morning show'), preset('daytime', 'Syndication'), preset('game', 'Access game shows'), preset('drama', 'Prime drama'), preset('reality', 'Talent competitions'), preset('latenight'), preset('variety', 'Sketch comedy'), preset('sports', 'Sunday Night Football')],
    days: {
      weekdays: usWeekday('morning', [['11:00', 'daytime'], ['12:00', 'news'], ['13:00', 'daytime']], [['20:00', 'reality', 'heavy'], ['21:00', 'drama', 'heavy']], [['23:35', 'latenight'], ['00:37', 'latenight', 'light'], ['01:40', 'daytime', 'light']]),
      saturday: [['07:00', 'morning'], ['09:00', 'daytime'], ['12:00', 'sports'], ['18:30', 'news'], ['19:00', 'game'], ['20:00', 'drama'], ['23:00', 'news'], ['23:30', 'variety', 'heavy'], ['01:00', 'daytime', 'light']],
      sunday: [['07:00', 'morning'], ['09:00', 'news'], ['11:00', 'daytime'], ['18:30', 'news'], ['19:00', 'sports'], ['20:20', 'sports', 'heavy'], ['23:30', 'news'], ['00:00', 'daytime', 'light']],
    },
  }),
  net({
    id: 'us-fox', name: 'FOX', network: 'FOX network programming', region: US,
    description: 'Local-news style mornings and a 22:00 late news, syndicated daytime, sitcom reruns in access, two hours of network prime time, an animation night on Sunday, and college and NFL football at weekends.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('news'), preset('daytime', 'Daytime syndication'), preset('sitcom', 'Sitcom reruns'), preset('drama', 'Prime-time series'), preset('cartoons', 'Animation night', 'Animated comedies'), preset('sports'), preset('movie')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'daytime'], ['17:00', 'news'], ['19:00', 'sitcom'], ['20:00', 'drama', 'heavy'], ['22:00', 'news'], ['23:00', 'sitcom'], ['01:00', 'daytime', 'light']],
      saturday: [['07:00', 'news'], ['09:00', 'daytime'], ['12:00', 'sports', 'heavy'], ['19:00', 'sitcom'], ['20:00', 'sports', 'heavy'], ['23:00', 'news'], ['23:30', 'sitcom'], ['01:00', 'movie', 'light']],
      sunday: [['07:00', 'news'], ['10:00', 'daytime'], ['13:00', 'sports', 'heavy'], ['19:00', 'sitcom'], ['20:00', 'cartoons', 'heavy'], ['22:00', 'news'], ['23:00', 'sitcom'], ['01:00', 'daytime', 'light']],
    },
  }),
  net({
    id: 'us-cw', name: 'The CW', network: 'The CW programming', region: US,
    description: 'Syndicated talk, court and sitcom reruns by day, two hours of network prime time (dramas, unscripted and sports), an educational Saturday-morning block.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('daytime', 'Syndication'), preset('court'), preset('sitcom', 'Sitcom reruns'), preset('drama', 'Prime series'), preset('reality', 'Unscripted'), preset('education', 'Saturday-morning learning'), preset('sports'), preset('movie')],
    days: {
      weekdays: [['06:00', 'sitcom', 'light'], ['09:00', 'daytime'], ['11:00', 'court'], ['14:00', 'daytime'], ['17:00', 'sitcom'], ['20:00', 'drama', 'heavy'], ['22:00', 'sitcom'], ['00:00', 'court', 'light']],
      saturday: [['07:00', 'education', 'light'], ['10:00', 'sitcom'], ['12:00', 'sports'], ['18:00', 'movie'], ['20:00', 'reality', 'heavy'], ['22:00', 'sitcom']],
      sunday: [['07:00', 'daytime', 'light'], ['10:00', 'sitcom'], ['12:00', 'sports'], ['18:00', 'movie'], ['20:00', 'reality', 'heavy'], ['22:00', 'sitcom']],
    },
  }),
  net({
    id: 'us-pbs', name: 'PBS', network: 'PBS programming', region: US,
    description: 'No commercials (underwriting only): preschool shows most of the day, the hour-long evening newshour, science and nature documentaries in prime time, British drama on Sunday nights, cooking and how-to on Saturdays.',
    ads: AD_STYLES.publicService, pad: 30, late: 15,
    roles: [preset('preschool', 'Kids'), preset('news', 'Newshour'), preset('docs', 'Science & nature'), preset('investigative', 'Investigative documentary'), preset('drama', 'British drama'), preset('lifestyle', 'Cooking & how-to'), preset('sitcom', 'British comedy'), preset('music', 'Concerts & arts')],
    days: {
      weekdays: [['05:00', 'preschool'], ['14:00', 'preschool'], ['17:00', 'lifestyle'], ['18:00', 'news'], ['19:00', 'lifestyle'], ['20:00', 'docs'], ['21:00', 'investigative'], ['22:00', 'docs'], ['23:00', 'news'], ['00:00', 'docs']],
      saturday: [['06:00', 'preschool'], ['10:00', 'lifestyle'], ['14:00', 'docs'], ['18:00', 'news'], ['19:00', 'sitcom'], ['20:00', 'music'], ['22:00', 'sitcom'], ['00:00', 'docs']],
      sunday: [['06:00', 'preschool'], ['10:00', 'lifestyle'], ['14:00', 'docs'], ['18:00', 'news'], ['19:00', 'docs'], ['21:00', 'drama'], ['22:00', 'drama'], ['23:00', 'docs']],
    },
  }),
  net({
    id: 'us-univision', name: 'Univision', network: 'Univision programming', region: US,
    description: 'Spanish-language: the morning show, talk and gossip in the afternoon, the 18:30 national news, telenovelas through prime time, late news; variety on Saturday night and the Sunday news magazine; soccer at weekends.',
    ads: AD_STYLES.usSpanish, pad: 5, late: 30,
    roles: [preset('news', 'Noticiero'), preset('morning', 'Morning show'), preset('talk', 'Talk & gossip'), preset('novela'), preset('reality', 'Reality & variety'), preset('sports', 'Fútbol'), preset('investigative', 'News magazine'), preset('movie', 'Cine')],
    days: {
      weekdays: [['05:00', 'news'], ['07:00', 'morning'], ['12:00', 'novela'], ['15:00', 'talk'], ['18:00', 'news'], ['19:00', 'novela', 'heavy'], ['22:00', 'reality'], ['23:00', 'news'], ['23:35', 'talk'], ['01:00', 'novela', 'light']],
      saturday: [['07:00', 'morning'], ['11:00', 'movie'], ['16:00', 'sports'], ['18:30', 'news'], ['19:00', 'reality', 'heavy'], ['22:00', 'sports'], ['00:00', 'movie', 'light']],
      sunday: [['07:00', 'morning'], ['11:00', 'news'], ['12:00', 'movie'], ['16:00', 'sports'], ['18:30', 'news'], ['19:00', 'investigative'], ['20:00', 'reality', 'heavy'], ['23:00', 'news']],
    },
  }),
  net({
    id: 'us-telemundo', name: 'Telemundo', network: 'Telemundo programming', region: US,
    description: 'Spanish-language: the morning show, talk and gossip in the afternoon, the national news, super-series and telenovelas in prime time, a live reality competition, late news; soccer at weekends.',
    ads: AD_STYLES.usSpanish, pad: 5, late: 30,
    roles: [preset('news', 'Noticias'), preset('morning', 'Morning show'), preset('talk', 'Talk & gossip'), preset('novela', 'Super-series & novelas'), preset('reality', 'Reality competition'), preset('sports', 'Fútbol'), preset('movie', 'Cine')],
    days: {
      weekdays: [['05:00', 'news'], ['07:00', 'morning'], ['12:00', 'novela'], ['15:00', 'talk'], ['18:00', 'news'], ['19:00', 'novela', 'heavy'], ['21:00', 'reality', 'heavy'], ['22:00', 'novela'], ['23:00', 'news'], ['23:35', 'novela', 'light']],
      saturday: [['07:00', 'morning'], ['11:00', 'movie'], ['16:00', 'sports'], ['18:30', 'news'], ['19:00', 'movie'], ['22:00', 'sports']],
      sunday: [['07:00', 'morning'], ['11:00', 'news'], ['12:00', 'sports'], ['18:30', 'news'], ['19:00', 'movie'], ['21:00', 'reality', 'heavy'], ['23:00', 'news']],
    },
  }),
  net({
    id: 'us-espn', name: 'ESPN', network: 'ESPN programming', region: US,
    description: 'Sports news in the morning, debate and talk shows through the day, studio shows, live games in the evening, the late sports news and replays overnight; Monday-night football and college football all Saturday.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('news', 'Sports news', 'Sports news and highlights'), preset('talk', 'Sports talk', 'Debate and talk shows'), preset('sports', 'Live games'), preset('docs', 'Sports documentary')],
    days: {
      weekdays: [['06:00', 'news'], ['10:00', 'talk'], ['15:00', 'talk'], ['18:00', 'news'], ['19:00', 'sports', 'heavy'], ['23:00', 'news'], ['00:00', 'sports', 'light'], ['03:00', 'docs', 'light']],
      monday: [['06:00', 'news'], ['10:00', 'talk'], ['15:00', 'talk'], ['18:00', 'news'], ['19:00', 'talk'], ['20:15', 'sports', 'heavy'], ['23:30', 'news'], ['00:30', 'sports', 'light'], ['03:00', 'docs', 'light']],
      saturday: [['07:00', 'news'], ['09:00', 'talk'], ['12:00', 'sports', 'heavy'], ['23:30', 'news'], ['00:30', 'docs', 'light']],
      sunday: [['07:00', 'news'], ['10:00', 'talk'], ['13:00', 'sports'], ['18:00', 'news'], ['19:00', 'sports', 'heavy'], ['23:00', 'news'], ['00:00', 'docs', 'light']],
    },
  }),
  net({
    id: 'us-cnn', name: 'CNN', network: 'CNN programming', region: US,
    description: 'Rolling news with anchor shows hour by hour, interviews in prime time and original documentary series on Sunday nights.',
    ads: AD_STYLES.news, pad: 30, late: 15,
    roles: [preset('news'), preset('politics', 'Anchor & interview shows'), preset('docs', 'Original series')],
    days: {
      weekdays: [['05:00', 'news'], ['12:00', 'politics'], ['14:00', 'news'], ['20:00', 'politics', 'heavy'], ['23:00', 'news'], ['01:00', 'docs', 'light']],
      saturday: [['06:00', 'news'], ['12:00', 'politics'], ['16:00', 'news'], ['20:00', 'docs'], ['23:00', 'news', 'light']],
      sunday: [['06:00', 'news'], ['09:00', 'politics'], ['12:00', 'news'], ['20:00', 'docs', 'heavy'], ['23:00', 'news', 'light']],
    },
  }),
  net({
    id: 'us-hbo', name: 'HBO', network: 'HBO programming', region: US,
    description: 'No commercials. Movies all day starting on the hour or half-hour, family films in the morning, a big premiere at 20:00, prestige drama late evening and on Sunday at 21:00, comedy after that; trailers fill the gaps.',
    ads: AD_STYLES.premium, pad: 30, late: 30,
    roles: [preset('family'), preset('movie'), preset('blockbuster', 'Premiere movie'), preset('drama', 'Prestige drama'), preset('sitcom', 'Comedy', 'Comedy series and specials', 'next'), { id: 'docs', label: 'Documentaries', hint: 'Documentary films', order: 'shuffle', suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['movie'] }, { field: 'genre', op: 'is', values: ['Documentary'] }] } }],
    days: {
      weekdays: [['06:00', 'family'], ['10:00', 'movie'], ['16:00', 'docs'], ['18:00', 'movie'], ['20:00', 'blockbuster'], ['22:00', 'drama'], ['23:00', 'sitcom'], ['00:00', 'movie']],
      saturday: [['06:00', 'family'], ['10:00', 'movie'], ['16:00', 'family'], ['18:00', 'movie'], ['20:00', 'blockbuster'], ['22:00', 'movie'], ['00:30', 'docs'], ['02:00', 'movie']],
      sunday: [['06:00', 'family'], ['10:00', 'movie'], ['16:00', 'drama'], ['19:00', 'movie'], ['21:00', 'drama'], ['22:00', 'sitcom'], ['23:00', 'movie']],
    },
  }),
  net({
    id: 'us-nickelodeon', name: 'Nickelodeon', network: 'Nickelodeon programming', region: US,
    description: 'Preschool shows all morning, cartoon marathons from midday, live-action kids sitcoms in the late afternoon, then classic family sitcoms all night.',
    ads: AD_STYLES.kids, pad: 15, late: 15,
    roles: [preset('preschool'), preset('cartoons'), preset('sitcom', 'Kids sitcoms', 'Live-action kids comedies'), named('nickatnite', preset('sitcom', 'Classic sitcoms overnight', 'Classic family sitcoms'))],
    days: { all: [['06:00', 'preschool', 'light'], ['12:00', 'cartoons'], ['17:00', 'sitcom'], ['20:00', 'nickatnite']] },
  }),
  net({
    id: 'us-disney', name: 'Disney Channel', network: 'Disney Channel programming', region: US,
    description: 'No commercials, only promos and interstitials: preschool in the morning, cartoons, live-action family sitcoms in the afternoon and a family movie in the evening (Friday premieres).',
    ads: AD_STYLES.promosOnly, pad: 5, late: 15,
    roles: [preset('preschool'), preset('cartoons'), preset('sitcom', 'Family sitcoms'), preset('family', 'Family movie')],
    days: {
      weekdays: [['06:00', 'preschool'], ['10:00', 'cartoons'], ['14:00', 'sitcom'], ['19:00', 'family'], ['21:00', 'sitcom'], ['01:00', 'cartoons']],
      friday: [['06:00', 'preschool'], ['10:00', 'cartoons'], ['14:00', 'sitcom'], ['20:00', 'family'], ['22:00', 'sitcom'], ['01:00', 'cartoons']],
      saturday: [['06:00', 'preschool'], ['09:00', 'cartoons'], ['13:00', 'family'], ['15:00', 'sitcom'], ['19:00', 'family'], ['21:00', 'sitcom']],
      sunday: [['06:00', 'preschool'], ['09:00', 'cartoons'], ['13:00', 'family'], ['15:00', 'sitcom'], ['19:00', 'family'], ['21:00', 'sitcom']],
    },
  }),
  net({
    id: 'us-cartoon-network', name: 'Cartoon Network & Adult Swim', network: 'Cartoon Network / Adult Swim programming', region: US,
    description: 'Preschool cartoons early, cartoons all day, then an animation-for-adults block from 20:00 through the night.',
    ads: AD_STYLES.kids, pad: 15, late: 15,
    roles: [preset('preschool'), preset('cartoons'), preset('adultanimation', 'Adult animation'), preset('anime', 'Late-night anime')],
    days: {
      weekdays: [['06:00', 'preschool', 'light'], ['09:00', 'cartoons'], ['20:00', 'adultanimation'], ['02:00', 'adultanimation', 'light']],
      saturday: [['06:00', 'cartoons'], ['20:00', 'adultanimation'], ['00:00', 'anime'], ['02:00', 'adultanimation', 'light']],
      sunday: [['06:00', 'cartoons'], ['20:00', 'adultanimation'], ['02:00', 'adultanimation', 'light']],
    },
  }),
  net({
    id: 'us-discovery', name: 'Discovery Channel', network: 'Discovery Channel programming', region: US,
    description: 'Factual and reality series all day, marathons of a hit series, new episodes of the flagship series in prime time, repeats overnight.',
    ads: AD_STYLES.us, pad: 30, late: 30,
    roles: [preset('docs', 'Documentary series'), preset('reality', 'Factual reality'), preset('lifestyle', 'How-to & cars')],
    days: { all: [['06:00', 'lifestyle', 'light'], ['10:00', 'reality'], ['20:00', 'reality', 'heavy'], ['23:00', 'docs'], ['02:00', 'lifestyle', 'light']] },
  }),
  net({
    id: 'us-mtv', name: 'MTV (classic)', network: 'classic MTV programming', region: US,
    description: 'The music-video era: video blocks by day, the afternoon countdown, rock and alternative at night, and reality series in prime time.',
    ads: AD_STYLES.music, pad: 1, late: 15,
    roles: [preset('musicvideos', 'Hits'), { id: 'countdown', label: 'Countdown', hint: 'Music videos, newest first', order: 'chronological', suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['music_video', 'other_video', 'track'] }] } }, preset('reality', 'Reality series'), { id: 'rock', label: 'Rock & alternative', hint: 'Rock videos', order: 'shuffle', suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['music_video', 'other_video', 'track'] }, { field: 'genre', op: 'is', values: ['Rock', 'Alternative', 'Metal'] }] } }],
    days: { all: [['06:00', 'musicvideos'], ['15:00', 'countdown'], ['17:00', 'musicvideos'], ['20:00', 'reality', 'heavy'], ['22:00', 'rock'], ['01:00', 'musicvideos', 'light']] },
  }),
  net({
    id: 'us-tcm', name: 'Turner Classic Movies', network: 'TCM programming', region: US,
    description: 'No commercials. Classic films back to back from the quarter hour, a prime-time feature at 20:00, westerns and noir at weekends and foreign films late on Sunday.',
    ads: AD_STYLES.premium, pad: 15, late: 30,
    roles: [preset('classic'), preset('movie', 'Prime-time feature', 'Celebrated dramas and romances'), preset('thriller', 'Noir & mystery', 'Crime and mystery films'), { id: 'western', label: 'Westerns', hint: 'Westerns', order: 'shuffle', suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['movie'] }, { field: 'genre', op: 'is', values: ['Western'] }] } }, { id: 'foreign', label: 'Foreign films', hint: 'World cinema', order: 'shuffle', suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['movie'] }, { field: 'genre', op: 'is', values: ['Foreign', 'Drama'] }] } }],
    days: {
      weekdays: [['06:00', 'classic'], ['20:00', 'movie'], ['00:00', 'thriller'], ['03:00', 'classic']],
      saturday: [['06:00', 'western'], ['12:00', 'classic'], ['20:00', 'thriller'], ['00:00', 'classic']],
      sunday: [['06:00', 'classic'], ['20:00', 'movie'], ['00:00', 'foreign'], ['03:00', 'classic']],
    },
  }),
];

// ------------------------------------------------------------------- Spain

const ES = 'Spain';
const spain: Template[] = [
  net({
    id: 'es-la1', name: 'La 1 (TVE)', network: 'La 1 (TVE) programming', region: ES,
    description: 'Public and commercial-free: the morning news and magazine, the 15:00 Telediario, the afternoon period telenovelas, a quiz before the 21:00 Telediario, then prime-time series and entertainment; Spanish classic cinema on Saturday afternoons.',
    ads: AD_STYLES.publicService, pad: 5, late: 20,
    roles: [preset('news', 'Telediario'), preset('talk', 'Magazine'), preset('novela', 'Period telenovela', 'Daily period drama, in order'), preset('game', 'Concurso'), preset('drama', 'Serie'), preset('variety', 'Entertainment'), preset('classic', 'Cine de barrio', 'Classic Spanish films'), preset('movie', 'Cine'), named('docs-la1', preset('docs', 'Documentales'))],
    days: {
      weekdays: [['06:00', 'news'], ['08:00', 'talk'], ['14:00', 'game'], ['15:00', 'news'], ['16:00', 'novela'], ['19:00', 'game'], ['21:00', 'news'], ['22:00', 'drama'], ['23:30', 'variety'], ['01:00', 'movie']],
      saturday: [['07:00', 'docs-la1'], ['13:00', 'game'], ['15:00', 'news'], ['16:00', 'movie'], ['18:00', 'classic'], ['21:00', 'news'], ['22:00', 'movie'], ['00:30', 'movie']],
      sunday: [['07:00', 'docs-la1'], ['13:00', 'game'], ['15:00', 'news'], ['16:00', 'movie'], ['21:00', 'news'], ['22:00', 'variety'], ['00:00', 'movie']],
    },
  }),
  net({
    id: 'es-la2', name: 'La 2 (TVE)', network: 'La 2 (TVE) programming', region: ES,
    description: 'Commercial-free culture: nature documentaries for the siesta, the long-running afternoon quiz, culture and debate, classic and art-house films late, sports at weekends.',
    ads: AD_STYLES.publicService, pad: 5, late: 20,
    roles: [preset('docs', 'Documentales'), preset('game', 'Quiz'), preset('education', 'Cultura'), preset('classic', 'Cine clásico'), preset('movie', 'Cine de autor', 'Art-house and world cinema'), preset('sports', 'Deportes')],
    days: {
      weekdays: [['06:00', 'education'], ['12:00', 'docs'], ['15:30', 'game'], ['16:30', 'docs'], ['20:00', 'education'], ['22:00', 'movie'], ['00:30', 'classic']],
      saturday: [['07:00', 'education'], ['11:00', 'sports'], ['16:00', 'docs'], ['20:00', 'education'], ['22:00', 'classic'], ['00:30', 'movie']],
      sunday: [['07:00', 'education'], ['11:00', 'sports'], ['16:00', 'docs'], ['20:00', 'education'], ['22:00', 'movie'], ['00:30', 'classic']],
    },
  }),
  net({
    id: 'es-antena3', name: 'Antena 3', network: 'Antena 3 programming', region: ES,
    description: 'Morning news and the morning magazine, a cooking show and the wheel game at lunchtime, the 15:00 news, the daily soap and talk in the afternoon, the word-game quiz before the 21:00 news, the late-evening talk show and prime-time series; TV movies at weekends.',
    ads: AD_STYLES.es, pad: 5, late: 30,
    roles: [preset('news', 'Noticias'), preset('talk', 'Magazine'), preset('lifestyle', 'Cocina', 'Cooking show'), preset('game', 'Concurso'), preset('soap', 'Serie diaria'), preset('latenight', 'Prime-access talk show'), preset('drama', 'Serie'), preset('movie', 'Multicine', 'Weekend TV movies'), named('kids-es', preset('kids', 'Infantil'))],
    days: {
      weekdays: [['06:15', 'news'], ['08:55', 'talk'], ['12:20', 'lifestyle'], ['13:00', 'game'], ['15:00', 'news'], ['15:45', 'soap'], ['17:30', 'talk'], ['19:00', 'game'], ['21:00', 'news'], ['21:45', 'latenight', 'heavy'], ['22:45', 'drama', 'heavy'], ['00:30', 'talk', 'light']],
      saturday: [['07:00', 'kids-es'], ['10:00', 'drama'], ['13:00', 'game'], ['15:00', 'news'], ['16:00', 'movie'], ['21:00', 'news'], ['22:00', 'movie', 'heavy']],
      sunday: [['07:00', 'kids-es'], ['10:00', 'drama'], ['13:00', 'game'], ['15:00', 'news'], ['16:00', 'movie'], ['21:00', 'news'], ['22:00', 'drama', 'heavy']],
    },
  }),
  net({
    id: 'es-telecinco', name: 'Telecinco', network: 'Telecinco programming', region: ES,
    description: 'The long morning magazine, midday talk, the 15:00 news, afternoon gossip talk, a game show before the 21:00 news and the big reality shows in prime time with late-night debates; weekend afternoon movies.',
    ads: AD_STYLES.es, pad: 5, late: 30,
    roles: [preset('news', 'Informativos'), preset('talk', 'Magazine & corazón'), preset('game', 'Concurso'), preset('reality', 'Reality'), preset('latenight', 'Late-night debate'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:30', 'news'], ['08:55', 'talk'], ['15:00', 'news'], ['16:00', 'talk'], ['20:00', 'game'], ['21:00', 'news'], ['22:00', 'reality', 'heavy'], ['01:00', 'latenight', 'light']],
      saturday: [['07:00', 'talk', 'light'], ['11:00', 'talk'], ['15:00', 'news'], ['16:00', 'movie'], ['20:00', 'game'], ['21:00', 'news'], ['22:00', 'reality', 'heavy'], ['01:00', 'latenight']],
      sunday: [['07:00', 'talk', 'light'], ['11:00', 'talk'], ['15:00', 'news'], ['16:00', 'movie'], ['20:00', 'game'], ['21:00', 'news'], ['22:00', 'reality', 'heavy'], ['01:00', 'latenight']],
    },
  }),
  net({
    id: 'es-cuatro', name: 'Cuatro', network: 'Cuatro programming', region: ES,
    description: 'Morning current-affairs talk, the 14:00 news, the afternoon satire panel, the 20:00 news, the dating show in prime access and factual and reality series in prime time; the Sunday-night mystery show.',
    ads: AD_STYLES.es, pad: 5, late: 30,
    roles: [preset('news', 'Noticias'), preset('politics', 'Mañanas'), preset('satire', 'Satire panel'), preset('reality', 'Dating & reality'), preset('investigative', 'Reportajes'), preset('docs', 'Mystery & documentary'), preset('movie', 'Cine'), preset('sports', 'Deportes')],
    days: {
      weekdays: [['07:00', 'news'], ['09:00', 'politics'], ['14:00', 'news'], ['15:30', 'satire'], ['17:00', 'politics'], ['20:00', 'news'], ['21:45', 'reality'], ['22:50', 'investigative', 'heavy'], ['01:00', 'docs', 'light']],
      saturday: [['08:00', 'reality', 'light'], ['12:00', 'sports'], ['14:00', 'news'], ['15:30', 'movie'], ['20:00', 'news'], ['21:30', 'movie', 'heavy'], ['00:00', 'docs']],
      sunday: [['08:00', 'reality', 'light'], ['12:00', 'sports'], ['14:00', 'news'], ['15:30', 'movie'], ['20:00', 'news'], ['21:45', 'docs', 'heavy'], ['00:30', 'investigative']],
    },
  }),
  net({
    id: 'es-lasexta', name: 'laSexta', network: 'laSexta programming', region: ES,
    description: 'Morning talk, the late-morning political talk show, the 14:00 news, the comedy panel, the afternoon talk, the 20:00 news, the satirical news show at 21:30 and investigative documentaries; the Saturday-night political talk.',
    ads: AD_STYLES.es, pad: 5, late: 30,
    roles: [preset('news', 'Noticias'), preset('talk', 'Morning talk'), preset('politics', 'Political talk'), preset('satire', 'Satirical news'), preset('investigative', 'Investigación'), preset('movie', 'Cine')],
    days: {
      weekdays: [['06:00', 'news'], ['09:00', 'talk'], ['11:00', 'politics'], ['14:00', 'news'], ['15:30', 'satire'], ['17:15', 'politics'], ['20:00', 'news'], ['21:30', 'satire', 'heavy'], ['22:30', 'investigative'], ['01:00', 'movie', 'light']],
      saturday: [['08:00', 'investigative', 'light'], ['14:00', 'news'], ['15:30', 'movie'], ['20:00', 'news'], ['21:30', 'politics', 'heavy'], ['02:00', 'investigative', 'light']],
      sunday: [['08:00', 'investigative', 'light'], ['14:00', 'news'], ['15:30', 'movie'], ['20:00', 'news'], ['21:30', 'investigative', 'heavy'], ['23:00', 'movie']],
    },
  }),
];

// ---------------------------------------------------------- United Kingdom

const UK = 'United Kingdom';
const unitedKingdom: Template[] = [
  net({
    id: 'uk-bbc-one', name: 'BBC One', network: 'BBC One programming', region: UK,
    description: 'No commercials. Breakfast news, daytime factual and quizzes, the News at One, Six and Ten, the evening magazine, the soap at 19:30, entertainment and drama in prime time; Saturday-night entertainment and football highlights, Sunday-night drama.',
    ads: AD_STYLES.publicService, pad: 5, late: 15,
    roles: [preset('news'), preset('morning', 'Breakfast'), preset('lifestyle', 'Daytime factual', 'Property, antiques and lifestyle'), preset('game', 'Quiz'), preset('talk', 'Evening magazine'), preset('soap'), preset('drama'), preset('reality', 'Entertainment'), preset('sitcom', 'Comedy'), preset('sports', 'Football highlights'), preset('docs', 'Countryside & factual'), named('chat-show', preset('latenight', 'Friday chat show'))],
    days: {
      weekdays: [['06:00', 'morning'], ['09:15', 'lifestyle'], ['13:00', 'news'], ['13:45', 'lifestyle'], ['16:30', 'game'], ['18:00', 'news'], ['19:00', 'talk'], ['19:30', 'soap'], ['20:00', 'reality'], ['21:00', 'drama'], ['22:00', 'news'], ['22:40', 'sitcom'], ['00:00', 'news']],
      friday: [['06:00', 'morning'], ['09:15', 'lifestyle'], ['13:00', 'news'], ['13:45', 'lifestyle'], ['16:30', 'game'], ['18:00', 'news'], ['19:00', 'talk'], ['19:30', 'reality'], ['21:00', 'sitcom'], ['22:00', 'news'], ['22:40', 'chat-show'], ['00:00', 'news']],
      saturday: [['07:00', 'morning'], ['10:00', 'lifestyle'], ['12:00', 'sports'], ['17:30', 'game'], ['18:30', 'reality'], ['20:30', 'drama'], ['22:00', 'news'], ['22:20', 'sports'], ['23:40', 'sitcom']],
      sunday: [['07:00', 'morning'], ['10:00', 'talk'], ['13:00', 'lifestyle'], ['18:00', 'news'], ['19:00', 'docs'], ['20:00', 'reality'], ['21:00', 'drama'], ['22:00', 'news'], ['22:30', 'sitcom']],
    },
  }),
  net({
    id: 'uk-bbc-two', name: 'BBC Two', network: 'BBC Two programming', region: UK,
    description: 'No commercials. Political news and repeats in the morning, factual and quizzes in the afternoon, the teatime quiz, documentaries and natural history at 20:00, comedy and drama at 21:00, the late news programme; sport and classic films at weekends.',
    ads: AD_STYLES.publicService, pad: 5, late: 15,
    roles: [preset('politics', 'Politics'), preset('docs', 'Documentary & natural history'), preset('game', 'Quiz'), preset('sitcom', 'Comedy'), preset('drama'), preset('news', 'Late news programme'), preset('sports'), preset('classic', 'Classic films')],
    days: {
      weekdays: [['06:30', 'docs', 'none'], ['11:00', 'politics'], ['13:00', 'docs'], ['18:30', 'game'], ['20:00', 'docs'], ['21:00', 'sitcom'], ['22:30', 'news'], ['23:15', 'drama'], ['00:30', 'classic']],
      saturday: [['07:00', 'docs'], ['12:00', 'sports'], ['18:00', 'classic'], ['20:00', 'docs'], ['21:00', 'drama'], ['23:00', 'classic']],
      sunday: [['07:00', 'docs'], ['12:00', 'sports'], ['18:00', 'classic'], ['20:00', 'docs'], ['21:00', 'sitcom'], ['22:00', 'classic']],
    },
  }),
  net({
    id: 'uk-itv1', name: 'ITV1', network: 'ITV1 programming', region: UK,
    description: 'The breakfast show, morning talk and the long magazine, the lunchtime panel show, the 13:30 news, afternoon quizzes and the big teatime quiz, regional and evening news, two soaps from 19:30, drama at 21:00 and the News at Ten; Saturday-morning cooking, Saturday-night entertainment and Sunday drama.',
    ads: AD_STYLES.uk, pad: 5, late: 20,
    roles: [preset('news'), preset('morning', 'Breakfast'), preset('talk', 'Morning magazine & talk'), preset('game', 'Quiz'), preset('soap'), preset('drama'), preset('reality', 'Saturday-night entertainment'), preset('lifestyle', 'Cooking & antiques'), preset('sports'), preset('movie', 'Film')],
    days: {
      weekdays: [['06:00', 'morning'], ['09:00', 'talk'], ['13:30', 'news'], ['14:00', 'lifestyle'], ['15:00', 'game'], ['18:00', 'news'], ['19:00', 'game'], ['19:30', 'soap'], ['21:00', 'drama', 'heavy'], ['22:00', 'news'], ['22:45', 'movie', 'light'], ['00:30', 'game', 'light']],
      saturday: [['06:00', 'morning'], ['09:30', 'lifestyle'], ['12:00', 'sports'], ['17:30', 'news'], ['18:00', 'game'], ['19:00', 'reality', 'heavy'], ['21:00', 'movie'], ['23:30', 'game', 'light']],
      sunday: [['06:00', 'morning'], ['09:30', 'lifestyle'], ['12:00', 'sports'], ['17:30', 'news'], ['18:30', 'reality', 'heavy'], ['21:00', 'drama', 'heavy'], ['22:00', 'news'], ['22:30', 'movie', 'light']],
    },
  }),
  net({
    id: 'uk-channel4', name: 'Channel 4', network: 'Channel 4 programming', region: UK,
    description: 'Daytime talk, the classic letters-and-numbers quiz, property shows, US animation at teatime, the 18:30 soap, the hour-long 19:00 news, documentaries and lifestyle at 20:00, entertainment and comedy late; weekend films and the Sunday brunch show.',
    ads: AD_STYLES.uk, pad: 5, late: 20,
    roles: [preset('news'), preset('talk', 'Daytime talk'), preset('game', 'Quiz'), preset('lifestyle', 'Property & lifestyle'), preset('cartoons', 'Teatime animation'), preset('soap'), preset('docs'), preset('reality', 'Entertainment & reality'), preset('sitcom', 'Comedy'), preset('movie', 'Film'), named('sunday-drama', preset('drama', 'Sunday drama'))],
    days: {
      weekdays: [['06:00', 'sitcom', 'light'], ['09:00', 'lifestyle'], ['12:00', 'talk'], ['14:10', 'game'], ['15:00', 'lifestyle'], ['17:00', 'game'], ['18:00', 'cartoons'], ['18:30', 'soap'], ['19:00', 'news'], ['20:00', 'docs'], ['21:00', 'reality', 'heavy'], ['22:00', 'sitcom'], ['23:00', 'movie', 'light']],
      saturday: [['06:00', 'sitcom', 'light'], ['10:00', 'lifestyle'], ['13:00', 'movie'], ['18:00', 'cartoons'], ['19:00', 'news'], ['19:30', 'docs'], ['21:00', 'movie', 'heavy'], ['23:30', 'sitcom']],
      sunday: [['06:00', 'sitcom', 'light'], ['10:00', 'talk'], ['13:00', 'movie'], ['18:00', 'cartoons'], ['19:00', 'news'], ['20:00', 'docs'], ['21:00', 'sunday-drama', 'heavy'], ['22:00', 'movie']],
    },
  }),
  net({
    id: 'uk-channel5', name: 'Channel 5', network: 'Channel 5 programming', region: UK,
    description: 'Preschool shows until 09:15, the morning current-affairs phone-in, lifestyle factual, the afternoon TV movie, factual series and the evening news, documentaries and crime docs in prime time, films late.',
    ads: AD_STYLES.uk, pad: 5, late: 20,
    roles: [preset('preschool'), preset('politics', 'Current-affairs phone-in'), preset('lifestyle', 'Lifestyle factual'), preset('movie', 'Afternoon TV movie', 'Thrillers and TV movies'), preset('news'), preset('docs', 'Factual & history'), preset('investigative', 'True crime'), preset('thriller', 'Late film')],
    days: {
      weekdays: [['06:00', 'preschool', 'none'], ['09:15', 'politics'], ['11:15', 'lifestyle'], ['13:45', 'movie'], ['15:45', 'lifestyle'], ['18:30', 'news'], ['19:00', 'docs'], ['21:00', 'investigative', 'heavy'], ['22:00', 'thriller'], ['00:30', 'docs', 'light']],
      saturday: [['06:00', 'preschool', 'none'], ['10:00', 'lifestyle'], ['13:00', 'movie'], ['18:30', 'news'], ['19:00', 'docs'], ['21:00', 'thriller', 'heavy'], ['23:30', 'docs', 'light']],
      sunday: [['06:00', 'preschool', 'none'], ['10:00', 'lifestyle'], ['13:00', 'movie'], ['18:30', 'news'], ['19:00', 'docs'], ['21:00', 'investigative', 'heavy'], ['22:00', 'thriller']],
    },
  }),
];

// ------------------------------------------------------------------- Italy

const IT = 'Italy';
const italy: Template[] = [
  net({
    id: 'it-rai1', name: 'Rai 1', network: 'Rai 1 programming', region: IT,
    description: 'The long morning news-magazine, talk, the midday cooking show, TG1 at 13:30 and 20:00, afternoon talk and the daily period drama, the teatime quiz, the 20:30 game show, then prime-time fiction or entertainment and the late political talk show; Saturday-night variety and the Sunday-afternoon variety show.',
    ads: AD_STYLES.itRai, pad: 5, late: 20,
    roles: [preset('news', 'TG'), preset('morning', 'Morning magazine'), preset('talk'), preset('lifestyle', 'Cucina', 'Cooking show'), preset('soap', 'Daily drama'), preset('game', 'Quiz & game show'), preset('drama', 'Fiction'), preset('variety', 'Varietà'), preset('politics', 'Late political talk'), preset('docs', 'Nature & food')],
    days: {
      weekdays: [['06:00', 'morning'], ['09:50', 'talk'], ['12:00', 'lifestyle'], ['13:30', 'news'], ['14:05', 'talk'], ['15:55', 'soap'], ['17:00', 'talk'], ['18:45', 'game'], ['20:00', 'news'], ['20:30', 'game', 'heavy'], ['21:30', 'drama', 'heavy'], ['23:30', 'politics'], ['01:00', 'news', 'light']],
      saturday: [['07:00', 'morning'], ['10:00', 'docs'], ['12:00', 'lifestyle'], ['13:30', 'news'], ['14:00', 'talk'], ['18:45', 'game'], ['20:00', 'news'], ['20:30', 'game'], ['21:30', 'variety', 'heavy'], ['00:30', 'news', 'light']],
      sunday: [['07:00', 'morning'], ['10:00', 'docs'], ['12:00', 'docs'], ['13:30', 'news'], ['14:00', 'variety'], ['18:45', 'game'], ['20:00', 'news'], ['20:30', 'game'], ['21:30', 'drama', 'heavy'], ['23:30', 'talk', 'light']],
    },
  }),
  net({
    id: 'it-rai2', name: 'Rai 2', network: 'Rai 2 programming', region: IT,
    description: 'Morning variety, TG2 at 13:00 and 20:30, afternoon crime series and talk, sports news at 18:00, US procedurals in the evening, series and entertainment in prime time; football at weekends.',
    ads: AD_STYLES.itRai, pad: 5, late: 20,
    roles: [preset('news', 'TG2'), preset('variety', 'Morning variety'), preset('procedural', 'Crime series'), preset('talk'), preset('sports', 'Sport'), preset('drama', 'Prime series'), preset('reality', 'Entertainment'), preset('cartoons', 'Weekend cartoons')],
    days: {
      weekdays: [['07:00', 'procedural', 'light'], ['11:00', 'variety'], ['13:00', 'news'], ['14:00', 'talk'], ['16:00', 'procedural'], ['18:00', 'sports'], ['19:00', 'procedural'], ['20:30', 'news'], ['21:20', 'drama', 'heavy'], ['23:00', 'reality'], ['00:30', 'procedural', 'light']],
      saturday: [['07:00', 'cartoons'], ['11:00', 'procedural'], ['13:00', 'news'], ['14:00', 'sports'], ['19:00', 'procedural'], ['20:30', 'news'], ['21:20', 'drama', 'heavy'], ['23:00', 'sports']],
      sunday: [['07:00', 'cartoons'], ['11:00', 'procedural'], ['13:00', 'news'], ['14:00', 'sports'], ['19:00', 'procedural'], ['20:30', 'news'], ['21:20', 'reality', 'heavy'], ['23:00', 'sports']],
    },
  }),
  net({
    id: 'it-rai3', name: 'Rai 3', network: 'Rai 3 programming', region: IT,
    description: 'Regional and national TG3, political talk, nature documentaries in the afternoon, the satirical clip show at 20:00, the long-running Naples soap at 20:50, investigative journalism and documentaries in prime time.',
    ads: AD_STYLES.itRai, pad: 5, late: 20,
    roles: [preset('news', 'TG3'), preset('politics', 'Political talk'), preset('docs', 'Nature documentaries'), preset('satire', 'Satirical clip show'), preset('soap', 'Evening soap'), preset('investigative', 'Inchiesta'), preset('movie', 'Film')],
    days: {
      weekdays: [['06:00', 'news'], ['08:00', 'politics'], ['12:00', 'news'], ['13:00', 'docs'], ['14:20', 'news'], ['15:00', 'docs'], ['19:00', 'news'], ['20:00', 'satire'], ['20:50', 'soap'], ['21:20', 'investigative', 'heavy'], ['23:15', 'news'], ['00:00', 'movie', 'light']],
      saturday: [['07:00', 'docs'], ['12:00', 'news'], ['14:30', 'politics'], ['16:00', 'docs'], ['19:00', 'news'], ['20:00', 'satire'], ['21:20', 'movie'], ['23:30', 'docs']],
      sunday: [['07:00', 'docs'], ['12:00', 'news'], ['14:30', 'politics'], ['16:00', 'docs'], ['19:00', 'news'], ['20:30', 'investigative', 'heavy'], ['23:00', 'movie']],
    },
  }),
  net({
    id: 'it-canale5', name: 'Canale 5', network: 'Canale 5 (Mediaset) programming', region: IT,
    description: 'Morning news and magazine, the court show at 11:00, TG5 at 13:00, the US soap and imported telenovelas, the dating talk show, afternoon talk, the teatime game show, TG5 at 20:00, the satirical news show, prime-time fiction and reality; weekend afternoon talk.',
    ads: AD_STYLES.itMediaset, pad: 5, late: 30,
    roles: [preset('news', 'TG5'), preset('morning', 'Mattino'), preset('court'), preset('soap', 'US soap'), preset('novela', 'Telenovela'), preset('reality', 'Dating & reality'), preset('talk', 'Afternoon talk'), preset('game'), preset('satire', 'Satirical news'), preset('drama', 'Fiction'), preset('movie', 'Film'), named('sunday-talk', preset('talk', 'Sunday talk'))],
    days: {
      weekdays: [['06:00', 'news'], ['08:45', 'morning'], ['11:00', 'court'], ['13:00', 'news'], ['13:40', 'soap'], ['14:10', 'novela'], ['14:45', 'reality'], ['16:00', 'novela'], ['17:00', 'talk'], ['18:45', 'game'], ['20:00', 'news'], ['20:40', 'satire', 'heavy'], ['21:20', 'drama', 'heavy'], ['00:30', 'news', 'light'], ['01:00', 'movie', 'light']],
      saturday: [['07:00', 'news'], ['08:00', 'morning'], ['11:00', 'court'], ['13:00', 'news'], ['14:00', 'talk'], ['16:00', 'talk'], ['18:45', 'game'], ['20:00', 'news'], ['20:40', 'satire'], ['21:20', 'reality', 'heavy'], ['00:30', 'movie']],
      sunday: [['07:00', 'news'], ['08:00', 'morning'], ['11:00', 'sunday-talk'], ['13:00', 'news'], ['14:00', 'talk'], ['18:45', 'game'], ['20:00', 'news'], ['20:40', 'satire'], ['21:20', 'drama', 'heavy'], ['00:30', 'movie']],
    },
  }),
  net({
    id: 'it-italia1', name: 'Italia 1', network: 'Italia 1 (Mediaset) programming', region: IT,
    description: 'Cartoons and anime in the morning, US sitcoms, the midday news and sports news, the classic yellow-family cartoon at 13:40, US series and action in the afternoon, the evening news, then films and the investigative-comedy show in prime time.',
    ads: AD_STYLES.itMediaset, pad: 5, late: 30,
    roles: [preset('cartoons'), preset('anime'), preset('sitcom', 'US sitcoms'), preset('news', 'Studio news'), preset('sports', 'Sport news'), named('familytoon', preset('cartoons', 'Animated sitcom', 'Animated family comedy')), preset('procedural', 'US series'), preset('blockbuster', 'Prime-time film'), preset('investigative', 'Investigative comedy'), named('late-film', preset('thriller', 'Late film'))],
    days: {
      weekdays: [['06:30', 'cartoons'], ['08:30', 'anime'], ['10:30', 'sitcom'], ['12:25', 'news'], ['13:00', 'sports'], ['13:40', 'familytoon'], ['14:30', 'procedural'], ['16:00', 'anime'], ['17:30', 'sitcom'], ['18:20', 'news'], ['19:00', 'procedural'], ['21:20', 'blockbuster', 'heavy'], ['23:30', 'procedural'], ['01:00', 'anime', 'light']],
      tuesday: [['06:30', 'cartoons'], ['08:30', 'anime'], ['10:30', 'sitcom'], ['12:25', 'news'], ['13:00', 'sports'], ['13:40', 'familytoon'], ['14:30', 'procedural'], ['16:00', 'anime'], ['17:30', 'sitcom'], ['18:20', 'news'], ['19:00', 'procedural'], ['21:20', 'investigative', 'heavy'], ['00:00', 'procedural'], ['01:00', 'anime', 'light']],
      saturday: [['06:30', 'cartoons'], ['09:00', 'anime'], ['12:25', 'news'], ['13:00', 'sports'], ['13:40', 'familytoon'], ['14:30', 'blockbuster'], ['18:20', 'news'], ['19:00', 'sitcom'], ['21:20', 'blockbuster', 'heavy'], ['23:30', 'late-film']],
      sunday: [['06:30', 'cartoons'], ['09:00', 'anime'], ['12:25', 'news'], ['13:00', 'sports'], ['13:40', 'familytoon'], ['14:30', 'blockbuster'], ['18:20', 'news'], ['19:00', 'sitcom'], ['21:20', 'investigative', 'heavy'], ['00:00', 'late-film']],
    },
  }),
  net({
    id: 'it-rete4', name: 'Rete 4', network: 'Rete 4 (Mediaset) programming', region: IT,
    description: 'TG4 through the day, crime series in the morning, the court show, imported soaps and telenovelas, classic films in the afternoon, the German romance soap before dinner and political talk in prime time; westerns and old films late.',
    ads: AD_STYLES.itMediaset, pad: 5, late: 30,
    roles: [preset('news', 'TG4'), preset('procedural', 'Crime series'), preset('court'), preset('novela', 'Soap & telenovela'), preset('classic', 'Classic films'), preset('politics', 'Political talk'), preset('movie', 'Late film')],
    days: {
      weekdays: [['06:00', 'news'], ['07:00', 'procedural', 'light'], ['10:50', 'court'], ['11:55', 'news'], ['12:20', 'novela'], ['15:30', 'news'], ['16:00', 'classic'], ['19:00', 'news'], ['19:40', 'novela'], ['20:30', 'politics'], ['21:20', 'politics', 'heavy'], ['00:30', 'movie', 'light']],
      saturday: [['06:00', 'news'], ['07:00', 'procedural', 'light'], ['11:55', 'news'], ['12:30', 'classic'], ['19:00', 'news'], ['19:40', 'novela'], ['21:20', 'movie', 'heavy'], ['23:30', 'classic']],
      sunday: [['06:00', 'news'], ['07:00', 'procedural', 'light'], ['11:55', 'news'], ['12:30', 'classic'], ['19:00', 'news'], ['19:40', 'novela'], ['21:20', 'politics', 'heavy'], ['00:00', 'classic']],
    },
  }),
  net({
    id: 'it-la7', name: 'La7', network: 'La7 programming', region: IT,
    description: 'Morning news and political talk, TG La7 at 13:30 and 20:00, afternoon talk, crime documentaries, the 20:35 political interview show, political talk and satire in prime time; films and documentaries at weekends.',
    ads: AD_STYLES.itMediaset, pad: 5, late: 30,
    roles: [preset('news', 'TG La7'), preset('politics', 'Political talk'), preset('talk', 'Afternoon talk'), preset('investigative', 'Crime documentaries'), preset('satire', 'Satire'), preset('movie', 'Film'), preset('docs', 'Documentari')],
    days: {
      weekdays: [['06:00', 'news'], ['07:00', 'politics'], ['11:00', 'politics'], ['13:30', 'news'], ['14:00', 'talk'], ['16:40', 'investigative'], ['20:00', 'news'], ['20:35', 'politics', 'heavy'], ['21:15', 'politics', 'heavy'], ['00:00', 'news', 'light'], ['01:00', 'movie', 'light']],
      friday: [['06:00', 'news'], ['07:00', 'politics'], ['11:00', 'politics'], ['13:30', 'news'], ['14:00', 'talk'], ['16:40', 'investigative'], ['20:00', 'news'], ['20:35', 'politics', 'heavy'], ['21:15', 'satire', 'heavy'], ['00:00', 'news', 'light'], ['01:00', 'movie', 'light']],
      saturday: [['07:00', 'news'], ['09:00', 'docs'], ['13:30', 'news'], ['14:00', 'movie'], ['20:00', 'news'], ['20:35', 'politics'], ['21:15', 'movie', 'heavy'], ['23:30', 'docs']],
      sunday: [['07:00', 'news'], ['09:00', 'docs'], ['13:30', 'news'], ['14:00', 'movie'], ['20:00', 'news'], ['20:35', 'politics'], ['21:15', 'docs', 'heavy'], ['23:30', 'movie']],
    },
  }),
];

export const REGIONS = ['Japan', 'Argentina', 'United States', 'Spain', 'United Kingdom', 'Italy'] as const;
export const NETWORK_TEMPLATES: Template[] = [...japan, ...argentina, ...unitedStates, ...spain, ...unitedKingdom, ...italy];
