'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { demoChannels, demoDate, demoProgramming } from '../lib/demoData';
import {
  buildManualSave,
  dayRange,
  hasGeneratedSchedule,
  scheduleForDay,
  reorderLineup,
  sameLineup,
  type Channel,
  type GuideProgram,
  type LineupItem,
  type Program,
  type Programming,
} from '../lib/lineup';
import { checkHealth, tunarrApi, TunarrApiError, type ConnectionState } from '../lib/tunarrClient';

type Mode = 'live' | 'demo';

type GuideState = { channelId: string; date: string; programs: GuideProgram[] };

type ConfirmDialog = {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
};

const MINUTE = 60_000;
const emptyProgramming: Programming = { lineup: [], programs: {} };

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
const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

function getProgram(item: LineupItem, programs: Programming['programs']): Program | undefined {
  if (!item.id) return undefined;
  const entry = programs[item.id];
  if (!entry) return undefined;
  // Tunarr wraps metadata in `program`; older payloads and demo data may not.
  const wrapped = (entry as { program?: Program }).program;
  return wrapped && typeof wrapped === 'object' ? wrapped : (entry as Program);
}

function programTitle(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  if (program?.type === 'episode') return program.show?.title || program.season?.show?.title || program.showTitle || program.title || 'Episode';
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

// Artwork is only shown when it is embedded. Remote artwork would make the
// browser contact Tunarr or a media server directly, which live mode avoids.
function programArtwork(item: LineupItem, programs: Programming['programs']) {
  const program = getProgram(item, programs);
  const path = item.icon || program?.artwork?.find((art) => ['thumbnail', 'poster', 'landscape'].includes(art.type || ''))?.path;
  return path && path.startsWith('data:image/') ? path : undefined;
}

function artTone(index: number) {
  return ['mint', 'coral', 'gold', 'blue', 'plum'][Math.max(0, index) % 5];
}

function connectionLabel(mode: Mode, connection: ConnectionState) {
  if (mode === 'demo') return 'Demo mode';
  switch (connection.status) {
    case 'checking': return 'Checking Tunarr…';
    case 'connected': return 'Tunarr connected';
    case 'not_configured': return 'Tunarr not configured';
    case 'unreachable': return 'Tunarr unreachable';
    case 'unavailable': return 'Live mode unavailable';
  }
}

export default function Home() {
  const [mode, setMode] = useState<Mode>('live');
  const [connection, setConnection] = useState<ConnectionState>({ status: 'checking' });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(false);
  const [channelsError, setChannelsError] = useState('');
  const [activeChannelId, setActiveChannelId] = useState('');
  const [programming, setProgramming] = useState<Programming>(emptyProgramming);
  const [originalLineup, setOriginalLineup] = useState<LineupItem[]>([]);
  const [programmingError, setProgrammingError] = useState('');
  const [guide, setGuide] = useState<GuideState | null>(null);
  const [guideLoading, setGuideLoading] = useState(false);
  const [guideError, setGuideError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedDate, setSelectedDate] = useState(demoDate);
  const [search, setSearch] = useState('');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [arrangeSearch, setArrangeSearch] = useState('');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const programmingRequest = useRef(0);
  const guideRequest = useRef(0);

  const live = mode === 'live';
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const dirty = !sameLineup(programming.lineup, originalLineup);
  const selectedItem = programming.lineup[selectedIndex];
  const guideIsCurrent = live && !dirty && guide?.channelId === activeChannelId && guide.date === selectedDate;
  const daySchedule = useMemo(() => {
    if (!activeChannel) return { rows: [], guideWindow: null, guideStale: false };
    return scheduleForDay(guideIsCurrent && guide ? guide.programs : null, programming.lineup, activeChannel.startTime, selectedDate);
  }, [activeChannel, guide, guideIsCurrent, programming.lineup, selectedDate]);
  const instances = daySchedule.rows;
  const visibleInstances = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return instances;
    return instances.filter(({ item, title }) => `${title ?? programTitle(item, programming.programs)} ${programDetail(item, programming.programs)}`.toLowerCase().includes(query));
  }, [instances, programming.programs, search]);
  const selectedInstance = instances.find((instance) => instance.lineupIndex === selectedIndex);

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? '' : current)), 3200);
  };

  // A Tunarr outage during any live request is reflected in the connection
  // status, but live mode stays live: it never switches to demo data on its own.
  const noteFailure = (error: unknown) => {
    if (error instanceof TunarrApiError && ['tunarr_unreachable', 'tunarr_timeout', 'companion_unreachable'].includes(error.code)) {
      setConnection({ status: 'unreachable', host: error.tunarrHost, message: error.message });
    }
  };

  const loadGuide = async (channelId: string, date: string) => {
    const request = ++guideRequest.current;
    setGuideLoading(true);
    setGuideError('');
    const { from, to } = dayRange(date);
    try {
      const data = await tunarrApi.lineup(channelId, from, to);
      if (request !== guideRequest.current) return;
      setGuide({ channelId, date, programs: Array.isArray(data?.programs) ? data.programs : [] });
    } catch (error) {
      if (request !== guideRequest.current) return;
      setGuide(null);
      setGuideError(errorMessage(error, 'Could not load the guide for this date.'));
      noteFailure(error);
    } finally {
      if (request === guideRequest.current) setGuideLoading(false);
    }
  };

  const loadProgramming = async (channelId: string, date: string, keepSelection = false) => {
    const request = ++programmingRequest.current;
    setActiveChannelId(channelId);
    setLoading(true);
    setProgrammingError('');
    if (!keepSelection) {
      setProgramming(emptyProgramming);
      setOriginalLineup([]);
      setGuide(null);
      setSelectedIndex(0);
    }
    try {
      const data = await tunarrApi.programming(channelId);
      if (request !== programmingRequest.current) return false;
      const lineup = Array.isArray(data?.lineup) ? data.lineup : [];
      const next = { ...data, lineup, programs: data?.programs ?? {} };
      setProgramming(next);
      setOriginalLineup(structuredClone(lineup));
      setSelectedIndex((current) => (keepSelection ? Math.min(current, Math.max(lineup.length - 1, 0)) : 0));
      void loadGuide(channelId, date);
      return true;
    } catch (error) {
      if (request !== programmingRequest.current) return false;
      setProgrammingError(errorMessage(error, 'Could not load this channel.'));
      noteFailure(error);
      return false;
    } finally {
      if (request === programmingRequest.current) setLoading(false);
    }
  };

  const loadChannels = async (date: string, preferredId?: string) => {
    setChannelsLoading(true);
    setChannelsError('');
    try {
      const list = await tunarrApi.channels();
      const sorted = [...list].sort((a, b) => a.number - b.number);
      setChannels(sorted);
      const next = sorted.find((channel) => channel.id === preferredId) ?? sorted[0];
      if (next) await loadProgramming(next.id, date);
      else setActiveChannelId('');
    } catch (error) {
      setChannelsError(errorMessage(error, 'Could not load channels.'));
      noteFailure(error);
    } finally {
      setChannelsLoading(false);
    }
  };

  const goLive = async () => {
    setConnection({ status: 'checking' });
    const state = await checkHealth();
    setConnection(state);
    if (state.status !== 'connected') {
      setConnectionOpen(true);
      return;
    }
    const today = inputDate(new Date());
    const preferredId = live ? activeChannelId : undefined;
    setMode('live');
    setChannels([]);
    setActiveChannelId('');
    setProgramming(emptyProgramming);
    setOriginalLineup([]);
    setGuide(null);
    setSelectedDate(today);
    setConnectionOpen(false);
    await loadChannels(today, preferredId);
  };

  useEffect(() => {
    // Initial check only; later checks are explicit user actions.
    let cancelled = false;
    checkHealth().then((state) => {
      if (cancelled) return;
      setConnection(state);
      if (state.status !== 'connected') {
        setConnectionOpen(true);
        return;
      }
      const today = inputDate(new Date());
      setSelectedDate(today);
      void loadChannels(today);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!live || !dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, dirty]);

  const guardUnsaved = (action: () => void) => {
    if (!dirty) {
      action();
      return;
    }
    setConfirmDialog({
      title: 'Discard unsaved changes?',
      body: live ? 'This lineup has changes that have not been saved to Tunarr. They will be lost.' : 'Your demo changes will be lost.',
      confirmLabel: 'Discard changes',
      onConfirm: action,
    });
  };

  const switchToDemo = () => guardUnsaved(() => {
    programmingRequest.current += 1;
    guideRequest.current += 1;
    const sample = demoProgramming();
    setMode('demo');
    setChannels(demoChannels);
    setChannelsError('');
    setActiveChannelId('studio');
    setProgramming(sample);
    setOriginalLineup(structuredClone(sample.lineup));
    setProgrammingError('');
    setGuide(null);
    setGuideError('');
    setLoading(false);
    setGuideLoading(false);
    setSelectedIndex(5);
    setSelectedDate(demoDate);
    setConnectionOpen(false);
    notify('Demo mode: sample data only, nothing is sent to Tunarr');
  });

  const loadChannel = (channel: Channel) => guardUnsaved(() => {
    if (!live) {
      const sample = demoProgramming();
      setActiveChannelId(channel.id);
      setProgramming(sample);
      setOriginalLineup(structuredClone(sample.lineup));
      setSelectedIndex(0);
      return;
    }
    void loadProgramming(channel.id, selectedDate);
  });

  const changeDate = (date: string) => {
    if (!date) return;
    setSelectedDate(date);
    if (live && activeChannelId && !programmingError) void loadGuide(activeChannelId, date);
  };

  const reorder = (from: number, to: number, swap = false) => {
    const result = reorderLineup(programming.lineup, from, to, swap);
    if (!result) return;
    setSelectedIndex(result.selectedIndex);
    setProgramming((current) => ({ ...current, lineup: result.lineup }));
    setArrangeOpen(false);
  };

  const nudge = (amount: number) => {
    const target = selectedIndex + amount;
    if (target >= 0 && target < programming.lineup.length) reorder(selectedIndex, target, true);
  };

  const performSave = async () => {
    const channelId = activeChannelId;
    const savedLineup = programming.lineup;
    const { request, skipped } = buildManualSave(savedLineup);
    setSaving(true);
    try {
      await tunarrApi.saveProgramming(channelId, request);
      setOriginalLineup(structuredClone(savedLineup));
      notify(skipped ? `Lineup saved to Tunarr (${skipped} zero-length ${skipped === 1 ? 'item' : 'items'} left out)` : 'Lineup saved to Tunarr');
      // Re-read what Tunarr actually stored rather than trusting local state.
      await loadProgramming(channelId, selectedDate, true);
      void tunarrApi.channels().then((list) => setChannels([...list].sort((a, b) => a.number - b.number))).catch(noteFailure);
    } catch (error) {
      notify(`Not saved: ${errorMessage(error, 'Could not save the lineup.')}`);
      noteFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!live) {
      setOriginalLineup(structuredClone(programming.lineup));
      notify('Demo changes saved for this session');
      return;
    }
    if (!activeChannelId || loading) return;
    if (hasGeneratedSchedule(programming)) {
      setConfirmDialog({
        title: 'Save over a generated schedule?',
        body: 'Tunarr builds this channel’s lineup from a slot or time schedule. Saving here stores it as a manual lineup, which can detach the channel from that schedule, and a later regeneration may overwrite these changes.',
        confirmLabel: 'Save manual lineup',
        onConfirm: () => void performSave(),
      });
      return;
    }
    void performSave();
  };

  const undo = () => {
    setProgramming((current) => ({ ...current, lineup: structuredClone(originalLineup) }));
    notify('Changes reverted');
  };

  const shiftDay = (amount: number) => {
    const date = new Date(`${selectedDate}T12:00:00`);
    date.setDate(date.getDate() + amount);
    changeDate(inputDate(date));
  };

  const retry = () => {
    if (channelsError || !channels.length) void loadChannels(selectedDate, activeChannelId);
    else if (activeChannelId) void loadProgramming(activeChannelId, selectedDate);
  };

  const selectedTitle = selectedItem ? programTitle(selectedItem, programming.programs) : 'Nothing selected';
  const selectedDetail = selectedItem ? programDetail(selectedItem, programming.programs) : '';
  const selectedArt = selectedItem ? programArtwork(selectedItem, programming.programs) : undefined;
  const arrangeCandidates = programming.lineup
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) => index !== selectedIndex && programTitle(item, programming.programs).toLowerCase().includes(arrangeSearch.toLowerCase()));
  const busy = loading || channelsLoading || guideLoading;
  const connectionClass = live && connection.status === 'connected' ? 'live' : live && connection.status !== 'checking' ? 'offline' : '';

  let sourceNote = '';
  if (!live) sourceNote = 'Demo data. Changes stay in this browser session and are never sent to Tunarr.';
  else if (dirty) sourceNote = 'Showing unsaved changes. Times are projected from the lineup until you save.';
  else if (guideError) sourceNote = `Tunarr’s guide for this date did not load (${guideError}). Times are projected from the lineup.`;
  else if (guideIsCurrent && programming.lineup.length) {
    const guideWindow = daySchedule.guideWindow;
    const { from, to } = dayRange(selectedDate);
    if (daySchedule.guideStale) sourceNote = 'Tunarr’s guide does not match this lineup yet (it may still be rebuilding). Times are projected from the lineup.';
    else if (!guideWindow) sourceNote = 'Tunarr’s guide does not reach this date yet. Times are projected from the lineup.';
    else if (guideWindow.start > from.getTime() || guideWindow.stop < to.getTime()) {
      sourceNote = `Times from ${timeLabel(Math.max(guideWindow.start, from.getTime()))} to ${timeLabel(Math.min(guideWindow.stop, to.getTime()))} come from Tunarr’s guide; the rest of the day is projected from the lineup.`;
    }
  }

  let emptyTitle = 'No programs here';
  let emptyText = search ? 'Try a different search.' : 'This date falls outside the current lineup.';
  let emptyRetry = false;
  if (!search && live) {
    if (connection.status === 'checking' || ((channelsLoading || loading) && !programmingError)) {
      emptyTitle = 'Loading from Tunarr…';
      emptyText = 'Reading this channel’s existing programming.';
    } else if (channelsError || programmingError) {
      emptyTitle = channelsError ? 'Couldn’t load channels' : 'Couldn’t load this channel';
      emptyText = channelsError || programmingError;
      emptyRetry = connection.status === 'connected' || connection.status === 'unreachable';
    } else if (connection.status !== 'connected' && !channels.length) {
      emptyTitle = 'Not connected to Tunarr';
      emptyText = connection.message;
    } else if (!channels.length) {
      emptyTitle = 'No channels yet';
      emptyText = 'Create a channel in Tunarr, then check again.';
      emptyRetry = true;
    } else if (!programming.lineup.length) {
      emptyTitle = 'No programming yet';
      emptyText = 'This channel has nothing scheduled in Tunarr.';
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"></span><span>Tunarr Lineup</span><nav className="menu-items" aria-label="Application menu"><span>File</span><span>Edit</span><span>View</span><span>Channel</span><span>Help</span></nav></div>
        <div className="top-actions">
          {dirty && <button className="quiet" onClick={undo}>Undo changes</button>}
          <button className={`connection ${connectionClass}`} onClick={() => setConnectionOpen(true)}><span className="status-dot" />{connectionLabel(mode, connection)}</button>
          <button className="primary save" disabled={!dirty || saving || loading} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save lineup' : 'Saved'}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="channel-rail">
          <div className="rail-heading"><p className="eyebrow">{live ? 'CHANNELS' : 'DEMO CHANNELS'}</p><span>{channels.length}</span></div>
          {channels.map((channel) => (
            <button className={`channel ${channel.id === activeChannelId ? 'active' : ''}`} key={channel.id} onClick={() => loadChannel(channel)}>
              <span className="channel-number">{channel.number}</span>
              <span className="channel-copy"><b>{channel.name}</b><small>{channel.programCount ?? '—'} lineup items</small></span>
            </button>
          ))}
          <div className="rail-note">
            {live ? <><b>No library clutter.</b><span>This view only changes programs already assigned to a channel.</span></> : <><b>Sample data.</b><span>Demo mode never reads from or writes to Tunarr.</span></>}
          </div>
        </aside>

        <section className="schedule" aria-busy={busy}>
          <div className="schedule-head">
            <div>
              <p className="eyebrow">{activeChannel ? `${live ? '' : 'DEMO · '}${activeChannel.name.toUpperCase()} · CH ${activeChannel.number}` : live ? 'TUNARR' : 'DEMO'}</p>
              <h1>{dateLabel(selectedDate)}</h1>
              <p className="subtle">Seek by date, then drag, move, or swap anything already in this lineup.</p>
              {sourceNote && <p className="subtle source-note">{sourceNote}</p>}
            </div>
            <div className="date-controls">
              <div className="stepper"><button aria-label="Previous day" onClick={() => shiftDay(-1)}>←</button><button onClick={() => changeDate(inputDate(new Date()))}>Today</button><button aria-label="Next day" onClick={() => shiftDay(1)}>→</button></div>
              <label className="date-picker"><span>Jump to date</span><input type="date" value={selectedDate} onChange={(event) => changeDate(event.target.value)} /></label>
            </div>
          </div>

          <div className="schedule-tools">
            <label className="search"><span>⌕</span><input aria-label="Search this day" placeholder="Search this day" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}>×</button>}</label>
            <span className="day-count">{visibleInstances.length} {visibleInstances.length === 1 ? 'program' : 'programs'}</span>
          </div>

          <div className={`timeline ${busy ? 'loading' : ''}`}>
            {!visibleInstances.length && <div className="empty"><span>○</span><h2>{emptyTitle}</h2><p>{emptyText}</p>{emptyRetry && <button onClick={retry}>Try again</button>}</div>}
            {visibleInstances.map((instance, position) => {
              const period = dayPeriod(instance.start);
              const showPeriod = position === 0 || dayPeriod(visibleInstances[position - 1].start) !== period;
              const guideOnly = instance.lineupIndex < 0;
              const title = instance.title ?? programTitle(instance.item, programming.programs);
              const detail = guideOnly ? `${instance.item.type} · in Tunarr’s guide only` : programDetail(instance.item, programming.programs);
              const art = guideOnly ? undefined : programArtwork(instance.item, programming.programs);
              return (
                <Fragment key={`${instance.start}-${instance.lineupIndex}`}>
                  {showPeriod && <div className="timeline-label"><span>{period}</span><i /></div>}
                  <button
                    className={`program ${!guideOnly && instance.lineupIndex === selectedIndex ? 'selected' : ''}`}
                    disabled={guideOnly}
                    onClick={() => setSelectedIndex(instance.lineupIndex)}
                    draggable={!guideOnly}
                    onDragStart={() => setDraggedIndex(instance.lineupIndex)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => { if (draggedIndex != null && !guideOnly) reorder(draggedIndex, instance.lineupIndex); setDraggedIndex(null); }}
                  >
                    <time>{timeLabel(instance.start)}</time>
                    <span className={`art ${artTone(instance.lineupIndex)} ${art ? 'has-image' : ''}`} style={art ? { backgroundImage: `url("${art.replaceAll('"', '%22')}")` } : undefined}>{art ? '' : title.slice(0, 1)}</span>
                    <span className="program-copy"><b>{title}</b><small>{detail}</small></span>
                    <span className="duration">{durationLabel(instance.stop - instance.start)}</span><span className="grip" aria-hidden="true">⠿</span>
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
            {hasGeneratedSchedule(programming) && <div className="warning"><b>Generated schedule</b><span>Tunarr may regenerate these manual changes from its slot schedule.</span></div>}
          </> : <p className="subtle">Choose a program to adjust it.</p>}
        </aside>
      </div>

      {connectionOpen && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectionOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
          <button className="modal-close" aria-label="Close" onClick={() => setConnectionOpen(false)}>×</button>
          <p className="eyebrow">YOUR EXISTING SERVER</p>
          {!live ? <>
            <h2 id="connect-title">Demo mode</h2>
            <p className="subtle">You are looking at sample channels. Nothing here is read from or written to Tunarr.</p>
            <button className="wide primary connect-button" disabled={connection.status === 'checking'} onClick={() => void goLive()}>{connection.status === 'checking' ? 'Checking…' : 'Connect to Tunarr'}</button>
            {connection.status !== 'checking' && connection.status !== 'connected' && <div className="warning"><b>Live mode is not available</b><span>{connection.message}</span></div>}
          </> : connection.status === 'connected' ? <>
            <h2 id="connect-title">Tunarr connected.</h2>
            <p className="subtle">Lineup reads and writes through Tunarr’s existing channel API. Nothing is imported or duplicated here.</p>
            <div className="info-row"><span>Server</span><b>{connection.host}</b></div>
            <div className="info-row"><span>Channels</span><b>{connection.channelCount}</b></div>
          </> : connection.status === 'checking' ? <>
            <h2 id="connect-title">Checking Tunarr…</h2>
            <p className="subtle">Asking the Lineup server whether Tunarr is reachable.</p>
          </> : connection.status === 'not_configured' ? <>
            <h2 id="connect-title">Tunarr isn’t configured</h2>
            <p className="subtle">{connection.message}</p>
            <p className="subtle">Set it to your Tunarr address and restart Lineup: <code>TUNARR_URL=http://tunarr:8000</code> in Docker Compose, or <code>TUNARR_URL=http://localhost:8000</code> when running locally. The address stays on the server; the browser never contacts Tunarr directly.</p>
          </> : connection.status === 'unreachable' ? <>
            <h2 id="connect-title">Can’t reach Tunarr</h2>
            <p className="subtle">{connection.message}</p>
            {connection.host && <div className="info-row single"><span>Tried</span><b>{connection.host}</b></div>}
            <p className="subtle">Check that Tunarr is running and that <code>TUNARR_URL</code> on the Lineup server points to it.</p>
          </> : <>
            <h2 id="connect-title">Live mode unavailable</h2>
            <p className="subtle">{connection.message} To edit a real Tunarr server, run the Lineup companion beside Tunarr (see the README), then open it from that server.</p>
          </>}
          {live && <div className="dialog-actions">
            <button disabled={connection.status === 'checking'} onClick={() => guardUnsaved(() => void goLive())}>Check again</button>
            <button onClick={switchToDemo}>Use demo data</button>
          </div>}
          <p className="fine-print">{live ? 'Demo data is sample content only and is never mixed with your channels.' : 'Connecting replaces the sample channels with your Tunarr channels.'}</p>
        </section>
      </div>}

      {confirmDialog && <div className="overlay" role="presentation">
        <section className="modal confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-body">
          <p className="eyebrow">PLEASE CONFIRM</p>
          <h2 id="confirm-title">{confirmDialog.title}</h2>
          <p className="subtle" id="confirm-body">{confirmDialog.body}</p>
          <div className="dialog-actions">
            <button autoFocus onClick={() => setConfirmDialog(null)}>Cancel</button>
            <button className="primary" onClick={() => { const action = confirmDialog.onConfirm; setConfirmDialog(null); action(); }}>{confirmDialog.confirmLabel}</button>
          </div>
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
