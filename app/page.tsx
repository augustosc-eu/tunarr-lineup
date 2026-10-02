'use client';

import { Fragment, useMemo, useState } from 'react';

type LineupItem = {
  type: string;
  duration: number;
  id?: string;
  icon?: string;
  [key: string]: unknown;
};

type Program = {
  title?: string;
  year?: number | null;
  type?: string;
  episodeNumber?: number;
  seasonNumber?: number;
  season?: { index?: number; number?: number; title?: string };
  show?: { title?: string };
  showTitle?: string;
  artistName?: string;
  albumName?: string;
  artwork?: Array<{ type?: string; path?: string | null }>;
  [key: string]: unknown;
};

type Programming = {
  lineup: LineupItem[];
  programs: Record<string, { program?: Program } | Program>;
  schedule?: unknown;
  totalPrograms?: number;
};

type Channel = {
  id: string;
  name: string;
  number: number;
  startTime: number;
  duration: number;
  programCount?: number;
  icon?: { path?: string };
};

type Instance = {
  item: LineupItem;
  lineupIndex: number;
  start: number;
  stop: number;
};

const HOUR = 3_600_000;
const MINUTE = 60_000;
const demoStart = new Date('2026-10-02T06:00:00').getTime();

const demoPrograms: Record<string, { program: Program }> = {
  earth: { program: { title: 'Fresh Water', show: { title: 'Planet Earth' }, type: 'episode', seasonNumber: 1, episodeNumber: 3, year: 2006 } },
  budapest: { program: { title: 'The Grand Budapest Hotel', type: 'movie', year: 2014 } },
  bobs: { program: { title: 'Work Hard or Die Trying, Girl', show: { title: 'Bob’s Burgers' }, type: 'episode', seasonNumber: 5, episodeNumber: 1 } },
  severance: { program: { title: 'Good News About Hell', show: { title: 'Severance' }, type: 'episode', seasonNumber: 1, episodeNumber: 1 } },
  arrival: { program: { title: 'Arrival', type: 'movie', year: 2016 } },
  office: { program: { title: 'Dinner Party', show: { title: 'The Office' }, type: 'episode', seasonNumber: 4, episodeNumber: 13 } },
  spirited: { program: { title: 'Spirited Away', type: 'movie', year: 2001 } },
  atlanta: { program: { title: 'Teddy Perkins', show: { title: 'Atlanta' }, type: 'episode', seasonNumber: 2, episodeNumber: 6 } },
  moonrise: { program: { title: 'Moonrise Kingdom', type: 'movie', year: 2012 } },
  twin: { program: { title: 'Zen, or the Skill to Catch a Killer', show: { title: 'Twin Peaks' }, type: 'episode', seasonNumber: 1, episodeNumber: 3 } },
};

const demoLineup: LineupItem[] = [
  { type: 'content', id: 'severance', duration: 57 * MINUTE },
  { type: 'content', id: 'arrival', duration: 116 * MINUTE },
  { type: 'content', id: 'office', duration: 22 * MINUTE },
  { type: 'content', id: 'spirited', duration: 125 * MINUTE },
  { type: 'content', id: 'earth', duration: 49 * MINUTE },
  { type: 'content', id: 'budapest', duration: 100 * MINUTE },
  { type: 'content', id: 'bobs', duration: 22 * MINUTE },
  { type: 'content', id: 'atlanta', duration: 41 * MINUTE },
  { type: 'content', id: 'moonrise', duration: 94 * MINUTE },
  { type: 'content', id: 'twin', duration: 47 * MINUTE },
  { type: 'flex', duration: 13 * MINUTE },
];

const demoChannels: Channel[] = [
  { id: 'studio', name: 'Studio Selects', number: 12, startTime: demoStart, duration: 0, programCount: demoLineup.length },
  { id: 'after', name: 'After Hours', number: 24, startTime: demoStart + 2 * HOUR, duration: 0, programCount: demoLineup.length },
  { id: 'kids', name: 'Kids Room', number: 88, startTime: demoStart - HOUR, duration: 0, programCount: demoLineup.length },
];

const demoProgramming: Programming = { lineup: demoLineup, programs: demoPrograms };

const dateLabel = (value: string) => new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const timeLabel = (ms: number) => new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const fullTimeLabel = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const durationLabel = (ms: number) => {
  const mins = Math.round(ms / MINUTE);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
};
const dayPeriod = (ms: number) => {
  const hour = new Date(ms).getHours();
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 22) return 'Evening';
  return 'Late night';
};
const cleanBaseUrl = (url: string) => url.trim().replace(/\/+$/, '');
const apiUrl = (base: string, path: string) => `${cleanBaseUrl(base)}${path}`;

function getProgram(item: LineupItem, programs: Programming['programs']) {
  if (!item.id) return undefined;
  const entry = programs[item.id];
  if (!entry) return undefined;
  return 'program' in entry ? entry.program : entry;
}

function programTitle(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  if (program?.type === 'episode') return program.show?.title || program.showTitle || program.title || 'Episode';
  if (program?.type === 'track') return program.artistName || program.title || 'Track';
  if (program?.title) return program.title;
  if (item.type === 'flex') return 'Flex time';
  if (item.type === 'redirect') return String(item.channelName || 'Channel redirect');
  if (item.type === 'custom') return 'Custom show';
  if (item.type === 'filler') return 'Filler';
  return 'Untitled program';
}

function programDetail(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  if (!program) return item.type === 'flex' ? 'Open airtime' : item.type;
  if (program.type === 'episode') {
    const season = program.seasonNumber ?? program.season?.index ?? program.season?.number;
    const episode = program.episodeNumber;
    const number = season != null && episode != null ? `S${String(season).padStart(2, '0')} E${String(episode).padStart(2, '0')} · ` : '';
    return `${number}${program.title || 'Episode'}`;
  }
  if (program.type === 'track') return [program.albumName, program.title].filter(Boolean).join(' · ');
  return [program.year, program.type && program.type.replace('_', ' ')].filter(Boolean).join(' · ');
}

function programArtwork(item: LineupItem, programs: Programming['programs'], baseUrl: string) {
  const program = getProgram(item, programs);
  const path = item.icon || program?.artwork?.find((art) => ['thumbnail', 'poster', 'landscape'].includes(art.type || ''))?.path;
  if (!path) return undefined;
  if (/^https?:\/\//.test(path)) return path;
  return baseUrl ? apiUrl(baseUrl, path.startsWith('/') ? path : `/${path}`) : path;
}

function instancesForDay(lineup: LineupItem[], startTime: number, date: string): Instance[] {
  const dayStart = new Date(`${date}T00:00:00`).getTime();
  const dayEnd = new Date(`${date}T00:00:00`).setDate(new Date(`${date}T00:00:00`).getDate() + 1);
  const cycleDuration = lineup.reduce((total, item) => total + Math.max(0, item.duration || 0), 0);
  if (!lineup.length || cycleDuration <= 0) return [];
  let cursor = startTime + Math.floor((dayStart - startTime) / cycleDuration) * cycleDuration;
  while (cursor > dayStart) cursor -= cycleDuration;
  const result: Instance[] = [];
  let guard = 0;
  while (cursor < dayEnd && guard < 20_000) {
    lineup.forEach((item, lineupIndex) => {
      const start = cursor;
      const stop = start + Math.max(0, item.duration || 0);
      if (stop > dayStart && start < dayEnd) result.push({ item, lineupIndex, start, stop });
      cursor = stop;
    });
    guard += lineup.length;
  }
  return result;
}

function artTone(index: number) {
  return ['mint', 'coral', 'gold', 'blue', 'plum'][index % 5];
}

export default function Home() {
  const [channels, setChannels] = useState<Channel[]>(demoChannels);
  const [activeChannelId, setActiveChannelId] = useState('studio');
  const [programming, setProgramming] = useState<Programming>(demoProgramming);
  const [originalLineup, setOriginalLineup] = useState<LineupItem[]>(demoLineup);
  const [selectedIndex, setSelectedIndex] = useState(5);
  const [selectedDate, setSelectedDate] = useState('2026-10-02');
  const [search, setSearch] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState(() =>
    typeof window === 'undefined'
      ? 'http://localhost:8000'
      : window.localStorage.getItem('tunarr-lineup-url') || 'http://localhost:8000',
  );
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [arrangeSearch, setArrangeSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);

  const activeChannel = channels.find((channel) => channel.id === activeChannelId) || channels[0];
  const dirty = JSON.stringify(programming.lineup) !== JSON.stringify(originalLineup);
  const selectedItem = programming.lineup[selectedIndex];
  const instances = useMemo(
    () => activeChannel ? instancesForDay(programming.lineup, activeChannel.startTime, selectedDate) : [],
    [activeChannel, programming.lineup, selectedDate],
  );
  const visibleInstances = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return instances;
    return instances.filter(({ item }) => `${programTitle(item, programming.programs)} ${programDetail(item, programming.programs)}`.toLowerCase().includes(query));
  }, [instances, programming.programs, search]);
  const selectedInstance = instances.find((instance) => instance.lineupIndex === selectedIndex);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 3200);
  };

  const loadChannel = async (channel: Channel, root = baseUrl) => {
    if (!root) {
      setActiveChannelId(channel.id);
      setProgramming({ ...demoProgramming, lineup: [...demoLineup] });
      setOriginalLineup([...demoLineup]);
      setSelectedIndex(0);
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(root, `/api/channels/${encodeURIComponent(channel.id)}/programming`));
      if (!response.ok) throw new Error(`Tunarr returned ${response.status}`);
      const data = await response.json() as Programming;
      setActiveChannelId(channel.id);
      setProgramming(data);
      setOriginalLineup(structuredClone(data.lineup));
      setSelectedIndex(0);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not load this channel.');
    } finally {
      setLoading(false);
    }
  };

  const connect = async () => {
    const root = cleanBaseUrl(urlDraft);
    if (!/^https?:\/\//.test(root)) {
      notify('Enter a full Tunarr URL, including http:// or https://');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(apiUrl(root, '/api/channels'));
      if (!response.ok) throw new Error(`Tunarr returned ${response.status}`);
      const loaded = await response.json() as Channel[];
      if (!loaded.length) throw new Error('This Tunarr server has no channels yet.');
      setChannels(loaded);
      setBaseUrl(root);
      window.localStorage.setItem('tunarr-lineup-url', root);
      setConnectionOpen(false);
      await loadChannel(loaded[0], root);
      notify(`Connected to ${root}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not connect to Tunarr.');
      setLoading(false);
    }
  };

  const disconnect = () => {
    setBaseUrl('');
    setChannels(demoChannels);
    setActiveChannelId('studio');
    setProgramming({ ...demoProgramming, lineup: [...demoLineup] });
    setOriginalLineup([...demoLineup]);
    setSelectedIndex(5);
    notify('Back in demo mode');
  };

  const reorder = (from: number, to: number, swap = false) => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...programming.lineup];
    if (swap) {
      [next[from], next[to]] = [next[to], next[from]];
      setSelectedIndex(to);
    } else {
      const [item] = next.splice(from, 1);
      const target = from < to ? to - 1 : to;
      next.splice(target, 0, item);
      setSelectedIndex(target);
    }
    setProgramming((current) => ({ ...current, lineup: next }));
    setArrangeOpen(false);
  };

  const nudge = (amount: number) => {
    const target = selectedIndex + amount;
    if (target >= 0 && target < programming.lineup.length) reorder(selectedIndex, target, true);
  };

  const save = async () => {
    if (!baseUrl) {
      setOriginalLineup(structuredClone(programming.lineup));
      notify('Demo changes saved for this session');
      return;
    }
    if (programming.schedule && !window.confirm('This channel uses a generated schedule. Saving manual changes may detach it from that schedule. Continue?')) return;
    setSaving(true);
    try {
      const response = await fetch(apiUrl(baseUrl, `/api/channels/${encodeURIComponent(activeChannel.id)}/programming`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'manual', lineup: programming.lineup.filter((item) => item.duration > 0), append: false }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Tunarr returned ${response.status}`);
      }
      const result = await response.json() as Programming;
      const nextLineup = result.lineup || programming.lineup;
      setProgramming((current) => ({ ...current, ...result, lineup: nextLineup }));
      setOriginalLineup(structuredClone(nextLineup));
      notify('Lineup saved to Tunarr');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save the lineup.');
    } finally {
      setSaving(false);
    }
  };

  const shiftDay = (amount: number) => {
    const date = new Date(`${selectedDate}T12:00:00`);
    date.setDate(date.getDate() + amount);
    setSelectedDate(inputDate(date));
  };

  const selectedTitle = selectedItem ? programTitle(selectedItem, programming.programs) : 'Nothing selected';
  const selectedDetail = selectedItem ? programDetail(selectedItem, programming.programs) : '';
  const selectedArt = selectedItem ? programArtwork(selectedItem, programming.programs, baseUrl) : undefined;
  const arrangeCandidates = programming.lineup
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => index !== selectedIndex && programTitle(item, programming.programs).toLowerCase().includes(arrangeSearch.toLowerCase()));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">T</span><span>Tunarr</span><b>Lineup</b></div>
        <div className="top-actions">
          {dirty && <button className="quiet" onClick={() => { setProgramming((current) => ({ ...current, lineup: structuredClone(originalLineup) })); notify('Changes reverted'); }}>Undo changes</button>}
          <button className={`connection ${baseUrl ? 'live' : ''}`} onClick={() => setConnectionOpen(true)}><span className="status-dot" />{baseUrl ? 'Tunarr connected' : 'Demo mode'}</button>
          {baseUrl && <button className="icon-button" aria-label="Disconnect Tunarr" title="Disconnect" onClick={disconnect}>×</button>}
          <button className="primary save" disabled={!dirty || saving} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save lineup' : 'Saved'}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="channel-rail">
          <div className="rail-heading"><p className="eyebrow">CHANNELS</p><span>{channels.length}</span></div>
          {channels.map((channel) => (
            <button className={`channel ${channel.id === activeChannelId ? 'active' : ''}`} key={channel.id} onClick={() => loadChannel(channel)}>
              <span className="channel-number">{channel.number}</span>
              <span className="channel-copy"><b>{channel.name}</b><small>{channel.programCount ?? '—'} lineup items</small></span>
            </button>
          ))}
          <div className="rail-note"><b>No library clutter.</b><span>This view only changes programs already assigned to a channel.</span></div>
        </aside>

        <section className="schedule" aria-busy={loading}>
          <div className="schedule-head">
            <div><p className="eyebrow">{activeChannel?.name?.toUpperCase()} · CH {activeChannel?.number}</p><h1>{dateLabel(selectedDate)}</h1><p className="subtle">Seek by date, then drag, move, or swap anything already in this lineup.</p></div>
            <div className="date-controls">
              <div className="stepper"><button aria-label="Previous day" onClick={() => shiftDay(-1)}>←</button><button onClick={() => setSelectedDate(inputDate(new Date()))}>Today</button><button aria-label="Next day" onClick={() => shiftDay(1)}>→</button></div>
              <label className="date-picker"><span>Jump to date</span><input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></label>
            </div>
          </div>

          <div className="schedule-tools">
            <label className="search"><span>⌕</span><input aria-label="Search this day" placeholder="Search this day" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}>×</button>}</label>
            <span className="day-count">{visibleInstances.length} {visibleInstances.length === 1 ? 'program' : 'programs'}</span>
          </div>

          <div className={`timeline ${loading ? 'loading' : ''}`}>
            {!visibleInstances.length && <div className="empty"><span>○</span><h2>No programs here</h2><p>{search ? 'Try a different search.' : 'This date falls outside the current lineup.'}</p></div>}
            {visibleInstances.map((instance, position) => {
              const period = dayPeriod(instance.start);
              const showPeriod = position === 0 || dayPeriod(visibleInstances[position - 1].start) !== period;
              const title = programTitle(instance.item, programming.programs);
              const detail = programDetail(instance.item, programming.programs);
              const art = programArtwork(instance.item, programming.programs, baseUrl);
              return (
                <Fragment key={`${instance.start}-${instance.lineupIndex}`}>
                  {showPeriod && <div className="timeline-label"><span>{period}</span><i /></div>}
                  <button
                    className={`program ${instance.lineupIndex === selectedIndex ? 'selected' : ''}`}
                    onClick={() => setSelectedIndex(instance.lineupIndex)}
                    draggable
                    onDragStart={() => setDraggedIndex(instance.lineupIndex)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (draggedIndex != null) reorder(draggedIndex, instance.lineupIndex); setDraggedIndex(null); }}
                  >
                    <time>{timeLabel(instance.start)}</time>
                    <span className={`art ${artTone(instance.lineupIndex)} ${art ? 'has-image' : ''}`} style={art ? { backgroundImage: `url("${art.replaceAll('"', '%22')}")` } : undefined}>{art ? '' : title.slice(0, 1)}</span>
                    <span className="program-copy"><b>{title}</b><small>{detail}</small></span>
                    <span className="duration">{durationLabel(instance.item.duration)}</span><span className="grip" aria-hidden="true">⠿</span>
                  </button>
                </Fragment>
              );
            })}
          </div>
        </section>

        <aside className="inspector">
          <p className="eyebrow">SELECTED PROGRAM</p>
          {selectedItem ? <>
            <div className={`poster ${artTone(selectedIndex)} ${selectedArt ? 'has-image' : ''}`} style={selectedArt ? { backgroundImage: `url("${selectedArt.replaceAll('"', '%22')}")` } : undefined}>{selectedArt ? '' : selectedTitle.slice(0, 1)}</div>
            <span className="type-chip">{selectedItem.type}</span>
            <h2>{selectedTitle}</h2>
            <p className="subtle inspector-detail">{selectedDetail} · {durationLabel(selectedItem.duration)}</p>
            <div className="info-row"><span>Starts</span><b>{selectedInstance ? fullTimeLabel(selectedInstance.start) : 'Repeating lineup'}</b></div>
            <div className="info-row"><span>Ends</span><b>{selectedInstance ? timeLabel(selectedInstance.stop) : '—'}</b></div>
            <div className="nudge-row"><button disabled={selectedIndex === 0} onClick={() => nudge(-1)}>↑ Earlier</button><button disabled={selectedIndex === programming.lineup.length - 1} onClick={() => nudge(1)}>↓ Later</button></div>
            <button className="wide primary" onClick={() => setArrangeOpen(true)}>Move or swap…</button>
            <p className="hint">Tip: you can also drag a row directly in the schedule.</p>
            {programming.schedule && <div className="warning"><b>Generated schedule</b><span>Tunarr may regenerate these manual changes from its slot schedule.</span></div>}
          </> : <p className="subtle">Choose a program to adjust it.</p>}
        </aside>
      </div>

      {connectionOpen && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectionOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
          <button className="modal-close" aria-label="Close" onClick={() => setConnectionOpen(false)}>×</button>
          <p className="eyebrow">YOUR EXISTING SERVER</p><h2 id="connect-title">Connect Tunarr</h2>
          <p className="subtle">Lineup reads and writes through Tunarr’s existing channel API. Nothing is imported or duplicated here.</p>
          <label className="field"><span>Tunarr URL</span><input value={urlDraft} onChange={(event) => setUrlDraft(event.target.value)} placeholder="http://192.168.1.50:8000" onKeyDown={(event) => { if (event.key === 'Enter') connect(); }} /></label>
          <button className="wide primary connect-button" disabled={loading} onClick={connect}>{loading ? 'Connecting…' : 'Connect to Tunarr'}</button>
          <p className="fine-print">Use the address you normally open Tunarr with. It stays in this browser.</p>
        </section>
      </div>}

      {arrangeOpen && selectedItem && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setArrangeOpen(false); }}>
        <section className="modal arrange-modal" role="dialog" aria-modal="true" aria-labelledby="arrange-title">
          <button className="modal-close" aria-label="Close" onClick={() => setArrangeOpen(false)}>×</button>
          <p className="eyebrow">MOVE OR SWAP</p><h2 id="arrange-title">Place “{selectedTitle}”</h2>
          <p className="subtle">Choose another program already in this channel. Move places the selected item before it; swap trades their positions.</p>
          <label className="search arrange-search"><span>⌕</span><input autoFocus aria-label="Find a program" placeholder="Find a program in this lineup" value={arrangeSearch} onChange={(event) => setArrangeSearch(event.target.value)} /></label>
          <div className="candidate-list">
            {arrangeCandidates.map(({ item, index }) => <div className="candidate" key={`${item.id || item.type}-${index}`}><span className={`mini-art ${artTone(index)}`}>{programTitle(item, programming.programs).slice(0, 1)}</span><span><b>{programTitle(item, programming.programs)}</b><small>{programDetail(item, programming.programs)}</small></span><span className="candidate-actions"><button onClick={() => reorder(selectedIndex, index)}>Move before</button><button onClick={() => reorder(selectedIndex, index, true)}>Swap</button></span></div>)}
          </div>
        </section>
      </div>}

      {message && <div className="toast" role="status">{message}</div>}
    </main>
  );
}
