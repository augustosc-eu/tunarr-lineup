// A small, stateful stand-in for Tunarr's channel API, used by the end-to-end
// suite. It implements only the endpoints Lineup's proxy calls, plus /__test/*
// hooks the tests use to reset state or simulate edits made elsewhere.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.FAKE_TUNARR_PORT) || 18000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// One transparent 1×1 PNG, standing in for program artwork.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const ids = {
  alpha: '0b6f5c4e-1a2b-4c3d-8e9f-000000000001',
  bravo: '0b6f5c4e-1a2b-4c3d-8e9f-000000000002',
  charlie: '0b6f5c4e-1a2b-4c3d-8e9f-000000000003',
  delta: '0b6f5c4e-1a2b-4c3d-8e9f-000000000004',
  news: '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa',
  movies: '5d0c1e8a-7b6a-4d4c-9e2f-0000000000bb',
  rotation: '5d0c1e8a-7b6a-4d4c-9e2f-0000000000cc',
  ep1: '0b6f5c4e-1a2b-4c3d-8e9f-0000000000e1',
  ep2: '0b6f5c4e-1a2b-4c3d-8e9f-0000000000e2',
  show: '7a7a7a7a-1a2b-4c3d-8e9f-0000000000f1',
  source: '3c3c3c3c-1a2b-4c3d-8e9f-000000000001',
  library: '3c3c3c3c-1a2b-4c3d-8e9f-000000000002',
  movieA: '4d4d4d4d-1a2b-4c3d-8e9f-000000000001',
  movieB: '4d4d4d4d-1a2b-4c3d-8e9f-000000000002',
  ads: '5e5e5e5e-1a2b-4c3d-8e9f-000000000001',
  ident: '4d4d4d4d-1a2b-4c3d-8e9f-000000000003',
  profile: '6f6f6f6f-1a2b-4c3d-8e9f-000000000001',
};

const libraryMovies = [
  { uuid: ids.movieA, type: 'movie', title: 'Zulu Dawn', year: 1979, duration: 90 * MINUTE },
  { uuid: ids.movieB, type: 'movie', title: 'Yankee Doodle Dandy', year: 1942, duration: 120 * MINUTE },
  // A ten-second clip, for station-ID lists.
  { uuid: ids.ident, type: 'movie', title: 'Desk Ident', year: 2026, duration: 10_000 },
];

const program = (id, title, extra = {}) => ({ type: 'content', id, duration: 30 * MINUTE, program: { title, type: 'movie', year: 2001, ...extra } });

const episode = (id, title) => ({ type: 'content', id, duration: 20 * MINUTE, program: { title, type: 'episode', show: { uuid: ids.show, title: 'Rotation Show' } } });

function initialState() {
  const startTime = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  return {
    channels: [
      // Logos like real Tunarr stores them: an upload saved under another host name, none, and a site that can't be reached.
      { id: ids.news, name: 'Desk News', number: 5, startTime, duration: 120 * MINUTE, programCount: 4, transcodeConfigId: ids.profile, icon: { path: 'http://host.docker.internal:8000/images/uploads/news.png', width: 0, duration: 0, position: 'bottom-right' } },
      { id: ids.movies, name: 'Desk Movies', number: 9, startTime, duration: 120 * MINUTE, programCount: 4, transcodeConfigId: ids.profile, icon: { path: '', width: 0, duration: 0, position: 'bottom-right' } },
      { id: ids.rotation, name: 'Desk Rotation', number: 12, startTime, duration: 100 * MINUTE, programCount: 3, transcodeConfigId: ids.profile, icon: { path: 'https://logos.example.invalid/rotation.png', width: 0, duration: 0, position: 'bottom-right' } },
    ],
    transcodeConfigs: [{ id: ids.profile, name: 'Default', isDefault: true, vaapiDevice: '/dev/dri/renderD128', resolution: { widthPx: 1920, heightPx: 1080 }, videoFormat: 'h264', videoBitRate: 2000, videoBufferSize: 4000, hardwareAccelerationMode: 'none', audioFormat: 'aac', audioBitRate: 192, audioBufferSize: 384, audioChannels: 2, audioSampleRate: 48, audioVolumePercent: 100, audioLoudnormConfig: null, normalizeFrameRate: false, deinterlaceVideo: true, disableChannelOverlay: false, errorScreen: 'pic', errorScreenAudio: 'silent', threadCount: 0, videoBitDepth: 8 }],
    smartCollections: [],
    mediaSources: [{ id: ids.source, name: 'Fake Plex', type: 'plex', uri: 'http://10.9.9.9:32400', accessToken: 'secret-token', username: 'secret-owner', libraries: [{ id: ids.library, name: 'Movies', mediaType: 'movies', enabled: true }] }],
    schedules: {
      [ids.rotation]: {
        type: 'random', flexPreference: 'end', maxDays: 2, padMs: 0, padStyle: 'slot', randomDistribution: 'weighted', lockWeights: false, timeZoneOffset: 0,
        slots: [
          { id: '9c9c9c9c-1a2b-4c3d-8e9f-000000000001', type: 'show', showId: ids.show, order: 'next', direction: 'asc', weight: 3, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 }, seasonFilter: [], seasonExcludeFilter: [] },
          { id: '9c9c9c9c-1a2b-4c3d-8e9f-000000000002', type: 'movie', order: 'shuffle', direction: 'asc', weight: 1, cooldownMs: 0, durationSpec: { type: 'dynamic', programCount: 1 } },
        ],
      },
    },
    lastScheduleSave: null,
    fillerLists: [{ id: ids.ads, name: 'Station Ads', programs: [{ type: 'content', id: ids.delta, duration: 15 * MINUTE, program: { title: 'Delta Weather', type: 'movie' } }] }],
    channelExtras: {},
    lineups: {
      [ids.news]: [
        { type: 'content', id: ids.alpha, duration: 30 * MINUTE, persisted: true },
        { type: 'flex', duration: 10 * MINUTE, persisted: true },
        { type: 'content', id: ids.bravo, duration: 25 * MINUTE, persisted: true, startOffsetMs: 0 },
        { type: 'redirect', channel: ids.movies, channelNumber: 9, channelName: 'Desk Movies', duration: 15 * MINUTE, persisted: true },
        { type: 'content', id: ids.charlie, duration: 25 * MINUTE, persisted: true },
        { type: 'content', id: ids.delta, duration: 15 * MINUTE, persisted: true },
      ],
      [ids.movies]: [
        { type: 'content', id: ids.delta, duration: 60 * MINUTE, persisted: true },
        { type: 'content', id: ids.charlie, duration: 60 * MINUTE, persisted: true },
      ],
      [ids.rotation]: [
        { type: 'content', id: ids.ep1, duration: 20 * MINUTE },
        { type: 'content', id: ids.ep2, duration: 20 * MINUTE },
        { type: 'content', id: ids.alpha, duration: 60 * MINUTE },
      ],
    },
    programs: {
      [ids.alpha]: program(ids.alpha, 'Alpha Hour'),
      [ids.bravo]: program(ids.bravo, 'Bravo Report'),
      [ids.charlie]: program(ids.charlie, 'Charlie Feature'),
      [ids.delta]: program(ids.delta, 'Delta Weather'),
      [ids.ep1]: episode(ids.ep1, 'Rotation Pilot'),
      [ids.ep2]: episode(ids.ep2, 'Rotation Finale'),
    },
    saves: 0,
  };
}

let state = initialState();

function guide(channel, lineup, from, to) {
  // Tunarr only keeps a guide around "now"; mimic that window.
  const windowFrom = Math.max(from, Date.now() - 6 * HOUR);
  const windowTo = Math.min(to, Date.now() + 18 * HOUR);
  const cycle = lineup.reduce((sum, item) => sum + item.duration, 0);
  const programs = [];
  if (!cycle || windowFrom >= windowTo) return programs;
  let cursor = channel.startTime + Math.floor((windowFrom - channel.startTime) / cycle) * cycle;
  while (cursor < windowTo) {
    for (const item of lineup) {
      const start = cursor;
      const stop = start + item.duration;
      cursor = stop;
      if (stop <= windowFrom || start >= windowTo) continue;
      if (item.type === 'flex') programs.push({ type: 'flex', start, stop, duration: item.duration, title: channel.name });
      else if (item.type === 'redirect') programs.push({ ...item, start, stop });
      else programs.push({ type: 'content', id: item.id, start, stop, duration: item.duration, program: state.programs[item.id]?.program });
    }
  }
  return programs;
}

// Like Tunarr, a local source gets one library per folder, named after its path.
// The fake "indexes" a folder by listing it, so uploads through Lineup show up.
const pathId = (text) => {
  const hex = createHash('sha1').update(text).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const folderPrograms = (folder) => {
  let names = [];
  try {
    names = readdirSync(folder).filter((name) => !name.startsWith('.'));
  } catch {
    // A folder Tunarr can't see is simply empty.
  }
  return names.map((name) => ({ uuid: pathId(`${folder}/${name}`), type: 'other_video', title: name.replace(/\.[^.]+$/, ''), duration: 30_000 }));
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => resolve(data));
});

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake');
  const path = url.pathname;

  if (path === '/__test/reset' && req.method === 'POST') {
    state = initialState();
    return send(res, 200, { ok: true });
  }
  if (path === '/__test/state') return send(res, 200, { lineups: state.lineups, saves: state.saves, schedules: state.schedules, lastScheduleSave: state.lastScheduleSave, fillerLists: state.fillerLists, smartCollections: state.smartCollections, mediaSources: state.mediaSources, transcodeConfigs: state.transcodeConfigs, channels: state.channels.map((channel) => ({ ...channel, ...state.channelExtras[channel.id] })) });

  // Tunarr setup: uploaded images, channels, transcode profiles, media sources, smart collections.
  if (/^\/images\/uploads\/[^/]+$/.test(path)) return send(res, 200, PNG, 'image/png');
  if (path === '/api/channels' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const id = `5d0c1e8a-7b6a-4d4c-9e2f-${String(state.channels.length + 1).padStart(12, '0')}`;
    const source = body.type === 'copy' ? state.channels.find((item) => item.id === body.channelId) : null;
    if (body.type === 'copy' && !source) return send(res, 404, '', 'text/plain');
    if (body.type === 'new' && !state.transcodeConfigs.some((item) => item.id === body.channel.transcodeConfigId)) return send(res, 400, { error: 'Transcode config not found' });
    const channel = source ? { ...source, id, name: `${source.name} - Copy`, number: 999 } : { ...body.channel, id, programCount: 0 };
    state.channels.push(channel);
    state.lineups[id] = source ? [...state.lineups[source.id]] : [];
    return send(res, 201, channel);
  }
  if (path === '/api/transcode_configs') return send(res, 200, state.transcodeConfigs);
  const transcode = /^\/api\/transcode_configs\/([^/]+)$/.exec(path);
  if (transcode) {
    const config = state.transcodeConfigs.find((item) => item.id === transcode[1]);
    if (!config) return send(res, 404, '', 'text/plain');
    if (req.method === 'PUT') Object.assign(config, JSON.parse(await readBody(req)));
    return send(res, 200, config);
  }
  if (path === '/api/media-sources' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const id = `3c3c3c3c-1a2b-4c3d-8e9f-${String(state.mediaSources.length + 10).padStart(12, '0')}`;
    const libraries = body.type === 'local' ? body.paths.map((folder) => ({ id: pathId(`${id}:${folder}`), name: folder, externalKey: folder, mediaType: body.mediaType, enabled: true, lastScannedAt: Date.now() })) : [];
    state.mediaSources.push({ ...body, id, libraries });
    return send(res, 201, { id });
  }
  const scan = /^\/api\/media-sources\/([^/]+)\/libraries\/[^/]+\/scan$/.exec(path);
  if (scan && req.method === 'POST') {
    // Tunarr rescans a whole local source; the fake finishes at once.
    for (const item of state.mediaSources.find((source) => source.id === scan[1])?.libraries ?? []) item.lastScannedAt = Date.now() + 1;
    return send(res, 202, '', 'text/plain');
  }
  const sourceRefresh = /^\/api\/media-sources\/([^/]+)\/libraries\/refresh$/.exec(path);
  if (sourceRefresh) {
    const source = state.mediaSources.find((item) => item.id === sourceRefresh[1]);
    if (source && !source.libraries.length) source.libraries.push({ id: `3c3c3c3c-1a2b-4c3d-8e9f-${String(state.mediaSources.length + 20).padStart(12, '0')}`, name: 'TV Shows', mediaType: 'shows', enabled: false });
    return send(res, 200, '', 'text/plain');
  }
  const library = /^\/api\/media-sources\/([^/]+)\/libraries\/([^/]+)$/.exec(path);
  if (library && req.method === 'PUT') {
    const item = state.mediaSources.find((source) => source.id === library[1])?.libraries.find((entry) => entry.id === library[2]);
    if (!item) return send(res, 404, '', 'text/plain');
    item.enabled = JSON.parse(await readBody(req)).enabled;
    return send(res, 200, item);
  }
  if (path === '/api/smart_collections' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const collection = { uuid: `8a8a8a8a-1a2b-4c3d-8e9f-${String(state.smartCollections.length + 1).padStart(12, '0')}`, name: body.name, keywords: body.keywords ?? '', filter: body.filter };
    state.smartCollections.push(collection);
    return send(res, 200, collection);
  }
  if (path === '/api/smart_collections') return send(res, 200, state.smartCollections);

  // Library, lists and channel settings (the Tunarr endpoints Lineup's content routes call).
  if (path === '/api/media-sources') return send(res, 200, state.mediaSources);
  if (path === '/api/programs/search' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const localLibrary = state.mediaSources.flatMap((source) => (source.type === 'local' ? source.libraries : [])).find((item) => item.id === body.libraryId);
    if (localLibrary) {
      const programs = folderPrograms(localLibrary.externalKey);
      return send(res, 200, { results: programs.slice(body.page * body.limit, (body.page + 1) * body.limit), page: body.page, totalHits: programs.length });
    }
    const filters = body.query?.filter?.children ?? (body.query?.filter ? [body.query.filter] : []);
    if (filters.some((node) => node.fieldSpec?.key === 'type' && node.fieldSpec.value?.[0] === 'show')) {
      const shows = [{ uuid: ids.show, type: 'show', title: 'Rotation Show', year: 2001, genres: [{ name: 'Comedy' }], grandchildCount: 2, mediaSourceId: ids.source, libraryId: ids.library }];
      return send(res, 200, { results: (body.page ?? 0) === 0 ? shows : [], page: body.page ?? 0, totalPages: 1, totalHits: shows.length });
    }
    if (filters.some((node) => node.fieldSpec?.key === 'type' && node.fieldSpec.value?.[0] === 'season')) {
      const seasons = [1, 2, 3].map((index) => ({ uuid: `7b7b7b7b-1a2b-4c3d-8e9f-00000000000${index}`, type: 'season', title: `Season ${index}`, index, childCount: 4 }));
      return send(res, 200, { results: seasons, page: 0, totalPages: 1, totalHits: seasons.length });
    }
    const text = (body.query?.query ?? '').toLowerCase();
    const results = libraryMovies.filter((movie) => movie.title.toLowerCase().includes(text));
    return send(res, 200, { results, page: body.page ?? 0, totalPages: 1, totalHits: results.length });
  }
  if (/^\/api\/programs\/[^/]+\/descendants$/.test(path)) return send(res, 200, []);
  if (path === '/api/custom-shows') return send(res, 200, []);
  if (path === '/api/filler-lists' && req.method === 'GET') return send(res, 200, state.fillerLists.map(({ id, name, programs }) => ({ id, name, contentCount: programs.length })));
  if (path === '/api/filler-lists' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !Array.isArray(body.programs) || !body.programs.length) return send(res, 400, 'A filler list must have at least one program.');
    const id = `5e5e5e5e-1a2b-4c3d-8e9f-${String(state.fillerLists.length + 1).padStart(12, '0')}`;
    state.fillerLists.push({ id, name: body.name, programs: body.programs });
    return send(res, 201, { id });
  }
  const filler = /^\/api\/filler-lists\/([^/]+)(\/programs)?$/.exec(path);
  if (filler) {
    const list = state.fillerLists.find((item) => item.id === filler[1]);
    if (!list) return send(res, 404, '', 'text/plain');
    if (filler[2]) return send(res, 200, list.programs);
    if (req.method === 'PUT') Object.assign(list, JSON.parse(await readBody(req)));
    if (req.method === 'DELETE') state.fillerLists = state.fillerLists.filter((item) => item !== list);
    return send(res, 200, list);
  }
  const channelDoc = /^\/api\/channels\/([^/]+)$/.exec(path);
  if (channelDoc) {
    const channel = state.channels.find((item) => item.id === channelDoc[1]);
    if (!channel) return send(res, 404, { error: 'Channel Not Found' });
    if (req.method === 'DELETE') {
      state.channels = state.channels.filter((item) => item !== channel);
      delete state.lineups[channel.id];
      return send(res, 200, '', 'text/plain');
    }
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      if ('programCount' in body || 'sessions' in body) return send(res, 400, 'Unexpected read-only fields');
      const { name, number, ...rest } = body;
      delete rest.id;
      state.channelExtras[channel.id] = { ...state.channelExtras[channel.id], ...rest };
      // Like Tunarr, a new start time moves when the lineup plays.
      Object.assign(channel, { name, number, icon: rest.icon ?? channel.icon, ...(typeof rest.startTime === 'number' ? { startTime: rest.startTime } : {}) });
    }
    return send(res, 200, { fillerCollections: [], fillerRepeatCooldown: 30000, disableFillerOverlay: false, guideMinimumDuration: 30000, guideFlexTitle: '', groupTitle: 'tunarr', transcodeConfigId: 'keep-me', ...channel, ...state.channelExtras[channel.id], sessions: [] });
  }
  // A stand-in for an OpenAI-compatible AI endpoint (LINEUP_AI_BASE_URL in the e2e setup).
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    state.aiRequests = (state.aiRequests ?? 0) + 1;
    const user = body.messages?.find((message) => message.role === 'user')?.content ?? '';
    const proposal = {
      name: 'AI comedy nights', description: 'Sitcoms in the evening, movies late.', notes: user.includes('Rotation Show') ? 'Built around Rotation Show.' : 'No shows found.',
      padMinutes: 30, latenessMinutes: 15,
      ads: { label: 'Short breaks', breakEveryMin: 10, breakMin: 2, maxBreaks: 2, commercialsAt: ['mid'], promosAt: [] },
      roles: [
        { id: 'comedy', label: 'Comedy', order: 'next', source: { kind: 'show', id: ids.show } },
        { id: 'films', label: 'Films', order: 'shuffle', source: { kind: 'suggest' }, suggest: { match: 'all', rules: [{ field: 'type', op: 'is', values: ['movie'] }] } },
      ],
      days: { all: [{ start: '18:00', role: 'comedy' }, { start: '21:00', role: 'films', ads: 'none' }] },
      lists: { commercialsListId: ids.ads },
    };
    return send(res, 200, { choices: [{ message: { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'propose_schedule', arguments: JSON.stringify(proposal) } }] } }] });
  }
  if (path === '/__test/edit-elsewhere' && req.method === 'POST') {
    const id = url.searchParams.get('channel');
    state.lineups[id] = [...state.lineups[id]].reverse();
    return send(res, 200, { ok: true });
  }

  if (path === '/api/channels' && req.method === 'GET') return send(res, 200, state.channels);

  const artwork = /^\/api\/programs\/([^/]+)\/artwork\/([^/]+)$/.exec(path);
  if (artwork && req.method === 'GET') return state.programs[artwork[1]] ? send(res, 200, PNG, 'image/png') : send(res, 404, '', 'text/plain');

  const match = /^\/api\/channels\/([^/]+)\/(programming|lineup|schedule|schedule-slots|schedule-time-slots)$/.exec(path);
  const channel = match && state.channels.find((item) => item.id === match[1]);
  if (!channel) return send(res, 404, { error: 'Channel Not Found' });

  // Stand-in for Tunarr's generator: rebuild the lineup from the program pool,
  // weighting show episodes by the show slot's weight.
  const generate = (schedule, pool) => {
    const showWeight = Math.max(1, Math.round(schedule.slots.find((slot) => slot.type === 'show')?.weight ?? 1));
    const lineup = [];
    for (const id of pool) {
      const copies = state.programs[id]?.program?.type === 'episode' ? showWeight : 1;
      for (let i = 0; i < copies; i += 1) lineup.push({ type: 'content', id, duration: state.programs[id].duration });
    }
    return lineup;
  };
  const poolFor = (id) => state.lineups[id].filter((item) => item.type === 'content').map((item) => item.id).filter((value, index, all) => all.indexOf(value) === index);

  if (match[2] === 'schedule') {
    const schedule = state.schedules[channel.id];
    if (!schedule) return send(res, 200, {});
    return send(res, 200, { schedule: { ...schedule, slots: schedule.slots.map((slot) => (slot.type === 'show' ? { ...slot, show: { uuid: ids.show, title: 'Rotation Show', mediaSourceId: ids.source, libraryId: ids.library } } : slot)) } });
  }
  if (match[2] === 'schedule-slots' || match[2] === 'schedule-time-slots') {
    const { schedule } = JSON.parse(await readBody(req));
    return send(res, 200, { startTime: channel.startTime, lineup: generate(schedule, poolFor(channel.id)), programs: state.programs, seed: [42], discardCount: 0 });
  }
  if (match[2] === 'programming' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.type === 'random' || body.type === 'time') {
      if (!Array.isArray(body.programs) || !body.schedule?.slots?.length) return send(res, 400, 'Invalid schedule');
      state.schedules[channel.id] = body.schedule;
      state.lineups[channel.id] = generate(body.schedule, [...new Set(body.programs)]);
      state.lastScheduleSave = { programs: body.programs, seed: body.seed, discardCount: body.discardCount };
    } else {
      if (body.type !== 'manual' || body.append !== false || !Array.isArray(body.lineup)) return send(res, 400, 'Invalid programming');
      // Programs added from the library become part of the channel.
      for (const item of body.lineup) {
        const movie = libraryMovies.find((entry) => entry.uuid === item.id);
        if (movie) state.programs[movie.uuid] = { type: 'content', id: movie.uuid, duration: movie.duration, program: movie };
      }
      state.lineups[channel.id] = body.lineup;
    }
    state.saves += 1;
  }
  if (match[2] === 'programming') {
    const lineup = state.lineups[channel.id];
    return send(res, 200, { name: channel.name, number: channel.number, totalPrograms: lineup.length, lineup, programs: state.programs, startTimeOffsets: [], schedule: state.schedules[channel.id] });
  }
  const from = Date.parse(url.searchParams.get('from'));
  const to = Date.parse(url.searchParams.get('to'));
  return send(res, 200, { id: channel.id, name: channel.name, number: channel.number, programs: guide(channel, state.lineups[channel.id], from, to) });
}).listen(PORT, '127.0.0.1', () => console.log(`fake Tunarr on http://127.0.0.1:${PORT}`));
