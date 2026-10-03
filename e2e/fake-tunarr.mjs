// A small, stateful stand-in for Tunarr's channel API, used by the end-to-end
// suite. It implements only the endpoints Lineup's proxy calls, plus /__test/*
// hooks the tests use to reset state or simulate edits made elsewhere.
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
};

const libraryMovies = [
  { uuid: ids.movieA, type: 'movie', title: 'Zulu Dawn', year: 1979, duration: 90 * MINUTE },
  { uuid: ids.movieB, type: 'movie', title: 'Yankee Doodle Dandy', year: 1942, duration: 120 * MINUTE },
];

const program = (id, title, extra = {}) => ({ type: 'content', id, duration: 30 * MINUTE, program: { title, type: 'movie', year: 2001, ...extra } });

const episode = (id, title) => ({ type: 'content', id, duration: 20 * MINUTE, program: { title, type: 'episode', show: { uuid: ids.show, title: 'Rotation Show' } } });

function initialState() {
  const startTime = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  return {
    channels: [
      { id: ids.news, name: 'Desk News', number: 5, startTime, duration: 120 * MINUTE, programCount: 4 },
      { id: ids.movies, name: 'Desk Movies', number: 9, startTime, duration: 120 * MINUTE, programCount: 4 },
      { id: ids.rotation, name: 'Desk Rotation', number: 12, startTime, duration: 100 * MINUTE, programCount: 3 },
    ],
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
  if (path === '/__test/state') return send(res, 200, { lineups: state.lineups, saves: state.saves, schedules: state.schedules, lastScheduleSave: state.lastScheduleSave, fillerLists: state.fillerLists, channels: state.channels.map((channel) => ({ ...channel, ...state.channelExtras[channel.id] })) });

  // Library, lists and channel settings (the Tunarr endpoints Lineup's content routes call).
  if (path === '/api/media-sources') return send(res, 200, [{ id: ids.source, name: 'Fake Plex', type: 'plex', uri: 'http://10.9.9.9:32400', username: 'secret-owner', libraries: [{ id: ids.library, name: 'Movies', mediaType: 'movies', enabled: true }] }]);
  if (path === '/api/programs/search' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const text = (body.query?.query ?? '').toLowerCase();
    const results = libraryMovies.filter((movie) => movie.title.toLowerCase().includes(text));
    return send(res, 200, { results, page: body.page ?? 0, totalPages: 1, totalHits: results.length });
  }
  if (/^\/api\/programs\/[^/]+\/descendants$/.test(path)) return send(res, 200, []);
  if (path === '/api/custom-shows') return send(res, 200, []);
  if (path === '/api/smart_collections') return send(res, 200, []);
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
    if (req.method === 'PUT') {
      const body = JSON.parse(await readBody(req));
      if ('programCount' in body || 'sessions' in body) return send(res, 400, 'Unexpected read-only fields');
      state.channelExtras[channel.id] = { ...state.channelExtras[channel.id], fillerCollections: body.fillerCollections, fillerRepeatCooldown: body.fillerRepeatCooldown };
      Object.assign(channel, { name: body.name, number: body.number });
    }
    return send(res, 200, { fillerCollections: [], fillerRepeatCooldown: 30000, disableFillerOverlay: false, guideMinimumDuration: 30000, guideFlexTitle: '', groupTitle: 'tunarr', transcodeConfigId: 'keep-me', ...channel, ...state.channelExtras[channel.id], sessions: [] });
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
    return send(res, 200, { schedule: { ...schedule, slots: schedule.slots.map((slot) => (slot.type === 'show' ? { ...slot, show: { uuid: ids.show, title: 'Rotation Show' } } : slot)) } });
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
