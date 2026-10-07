'use client';

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelSettingsDialog } from './components/ChannelSettingsDialog';
import { DayStrip } from './components/DayStrip';
import { EventDialog } from './components/EventDialog';
import { InsertDialog } from './components/InsertDialog';
import { LibraryBrowser, type LibraryPick } from './components/LibraryBrowser';
import { ListsManager } from './components/ListsManager';
import { MenuBar, type Menu } from './components/MenuBar';
import { MediaSourcesDialog } from './components/MediaSourcesDialog';
import { FillerFoldersDialog } from './components/FillerFoldersDialog';
import { MoveDialog } from './components/MoveDialog';
import { NewChannelDialog } from './components/NewChannelDialog';
import { ScheduleEditor } from './components/ScheduleEditor';
import { SmartCollectionsManager } from './components/SmartCollectionsManager';
import { TemplatesDialog, type TemplateTarget } from './components/TemplatesDialog';
import { TranscodeProfilesDialog } from './components/TranscodeProfilesDialog';
import { spotTitle, useFillerSpots } from './useFillerSpots';
import { airKind, estimateBreakFill, hourSummaries, KIND_BADGES, KIND_LABELS, stripSegments, type AirKind } from '../lib/airKinds';
import { channelStationIds, type FillerRole } from '../lib/fillerRoles';
import {
  changedPositions,
  clockTimecode,
  dayTotals,
  durationTimecode,
  hasAdjustableLength,
  insertItems,
  moveBlock,
  moveBlockToPosition,
  moveBlockToTime,
  normalizeBlock,
  occurrenceStart,
  onAirPosition,
  openBreaksWithIds,
  pickStationId,
  removeBlock,
  setItemDuration,
  shiftBlock,
  toCsv,
  type Block,
} from '../lib/broadcast';
import { demoChannels, demoDate, demoProgramming } from '../lib/demoData';
import { decodeDraft, draftStore, encodeDraft } from '../lib/draftStore';
import { emptyHistory, itemIdentity, rebaseHistory, record, redo as redoHistory, undo as undoHistory, type History } from '../lib/history';
import {
  buildManualSave,
  cycleDuration,
  dayRange,
  hasGeneratedSchedule,
  reorderLineup,
  sameLineup,
  scheduleForDay,
  type Channel,
  type GuideProgram,
  type Instance,
  type LineupItem,
  type Programming,
} from '../lib/lineup';
import { channelLogoUrl, programArtwork, programDetail, programTitle } from '../lib/programInfo';
import { boundaryAt, insertedStart, passesBefore, type EventPlacement, type InsertWhere } from '../lib/events';
import { keptStartTime, lineupLength } from '../server/lineupVersion';
import { lineupEntry, seasonsFromEpisodes, type ContentProgram } from '../lib/library';
import { changeSlotSource, draftFromSchedule, newSlot, showOption, type SchedulePreview, type ScheduleDraftState, type SeasonInfo, type Slot, type SlotCatalog, type SlotSchedule } from '../lib/schedule';
import { programmingVersion } from '../server/lineupVersion';
import { checkHealth, tunarrApi, TunarrApiError, type ConnectionState } from '../lib/tunarrClient';

type Mode = 'live' | 'demo';

type GuideState = { channelId: string; date: string; programs: GuideProgram[] };

type ConfirmDialog = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
};

/** A block picked up with OK/Enter and slid with the arrow keys. */
type Grab = { before: LineupItem[]; block: Block };

/** The lineup exactly as Tunarr returned it, which drafts and saves are based on. */
type Base = { channelId: string; version: string; lineup: LineupItem[] };

type SlotEditor = {
  channelId: string;
  open: boolean;
  busy: boolean;
  error: string;
  /** The channel has no slot schedule yet; saving creates one. */
  isNew: boolean;
  loaded: boolean;
  draft: ScheduleDraftState;
  saved: ScheduleDraftState | null;
  preview: SchedulePreview | null;
  /** JSON of the draft the preview was generated from. */
  previewOf: string;
  showingPreview: boolean;
};

type LibraryPicker = { purpose: 'insert'; where: InsertWhere } | { purpose: 'slot-show'; index: number | null } | { purpose: 'movies' };

const closedSlotEditor: SlotEditor = { channelId: '', open: false, busy: false, error: '', isNew: false, loaded: false, draft: draftFromSchedule(null), saved: null, preview: null, previewOf: '', showingPreview: false };
const draftKey = (draft: ScheduleDraftState) => JSON.stringify([draft.type, draft.settings, draft.slots, draft.extraMovies.map((movie) => movie.id)]);

const emptyProgramming: Programming = { lineup: [], programs: {} };
const NOW_TICK_MS = 15_000;

const dateLabel = (value: string) => new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
/** “A”, “A” and “B”, or “A”, “B” and 3 more: what an insert added, for the edit list. */
const insertedLabel = (programs: ContentProgram[]) => {
  const titles = programs.map((program) => `“${String((program.program as { title?: string }).title ?? 'program')}”`);
  if (titles.length <= 2) return titles.join(' and ');
  if (titles.length === 3) return `${titles[0]}, ${titles[1]} and ${titles[2]}`;
  return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more`;
};
const inputTime = (ms: number) => { const date = new Date(ms); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; };
const fullTimeLabel = (ms: number) => `${new Intl.DateTimeFormat('en', { weekday: 'short' }).format(new Date(ms))} ${clockTimecode(ms)}`;
const dayPeriod = (ms: number) => {
  const hour = new Date(ms).getHours();
  if (hour < 12) return 'Morning';
  if (hour < 17) return 'Afternoon';
  if (hour < 22) return 'Evening';
  return 'Late night';
};
const errorMessage = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

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

function scheduleSummary(schedule: unknown) {
  if (!schedule || typeof schedule !== 'object') return 'a generated schedule';
  const { type, slots } = schedule as { type?: unknown; slots?: unknown };
  const kind = type === 'time' ? 'time-slot schedule' : type === 'random' ? 'random-slot schedule' : 'generated schedule';
  return Array.isArray(slots) ? `its ${kind} (${slots.length} ${slots.length === 1 ? 'slot' : 'slots'})` : `its ${kind}`;
}

/** A show slot's seasons: searched in its library when known, otherwise counted from its episodes. */
async function loadSeasons(slot: Slot): Promise<SeasonInfo[]> {
  const showId = String(slot.showId ?? '');
  const show = slot.show as { mediaSourceId?: string; libraryId?: string } | undefined;
  if (show?.mediaSourceId) {
    try {
      const result = await tunarrApi.searchLibrary({ mediaSourceId: show.mediaSourceId, libraryId: show.libraryId, type: 'season', parentId: showId, limit: 100 });
      const seasons = result.results.filter((item) => Number.isInteger(item.index)).map((item) => ({ number: item.index as number, title: item.title, episodes: item.childCount }));
      if (seasons.length) return seasons.sort((a, b) => a.number - b.number);
    } catch {
      // Fall back to counting episodes below.
    }
  }
  return seasonsFromEpisodes(await tunarrApi.descendants(showId));
}

/** The channel's logo, or its number when it has none (or it fails to load). */
function ChannelLogo({ channel, live, className = 'channel-logo' }: { channel: Channel; live: boolean; className?: string }) {
  const src = channelLogoUrl(channel, live);
  const [failed, setFailed] = useState('');
  if (!src || failed === src) return <span className={`${className} no-logo`} aria-hidden="true">{channel.number}</span>;
  return (
    <span className={className}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} />
    </span>
  );
}

const isTypingTarget = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]');

/** Art tile: Tunarr artwork when available, otherwise the coloured initial. */
function ArtTile({ className, tone, title, src }: { className: string; tone: string; title: string; src?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = src && failed !== src;
  return (
    <span className={`${className} ${tone} ${showImage ? 'has-image' : ''}`}>
      {/* next/image doesn't apply: the companion build has no Next image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {showImage ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} /> : title.slice(0, 1)}
    </span>
  );
}

/** Minutes/seconds editor for flex, commercial breaks and redirects. */
const KIND_GLYPHS: Record<AirKind, string> = {
  program: '', break: '¢', flex: '░', 'station-id': 'ID', commercial: '¢', promo: '▸', bumper: '◆', filler: '▤', redirect: '↪',
};

/** The hour's log line: how its airtime splits between programs, commercials, IDs and flex. */
function HourLog({ start, summary }: { start: number; summary: Partial<Record<AirKind, number>> }) {
  const order: AirKind[] = ['program', 'break', 'commercial', 'station-id', 'promo', 'bumper', 'filler', 'flex', 'redirect'];
  const parts = order.filter((kind) => (summary[kind] ?? 0) >= 1000);
  const commercial = (['break', 'commercial', 'promo', 'bumper', 'filler'] as AirKind[]).reduce((sum, kind) => sum + (summary[kind] ?? 0), 0);
  return (
    <div className="hour-log" aria-label={`${clockTimecode(start).slice(0, 5)} hour`}>
      <b>{clockTimecode(start).slice(0, 5)}</b>
      {parts.map((kind) => <span key={kind} className={`kind-${kind}`}><i className="swatch" aria-hidden="true" />{KIND_LABELS[kind]} {durationTimecode(summary[kind] ?? 0)}</span>)}
      {commercial > 0 && <span className="hour-load">{Math.round(commercial / 60_000)} min commercial time</span>}
    </div>
  );
}

/** A commercial break's estimated spots, under its row. */
function BreakRundown({ start, lines }: { start: number; lines: ReturnType<typeof estimateBreakFill> }) {
  const starts = lines.reduce<number[]>((list, line, index) => [...list, index ? list[index - 1] + lines[index - 1].duration : start], []);
  return (
    <ol className="rundown" aria-label="Estimated break rundown">
      {!lines.length && <li className="rundown-empty">No spots known for this break’s filler lists.</li>}
      {lines.map((line, index) => {
        const at = starts[index];
        return <li key={index} className={`kind-${line.kind}`}><time>{clockTimecode(at)}</time><em className="kind-badge">{KIND_BADGES[line.kind] || 'SPOT'}</em><span><b>{line.title}</b><small>{line.detail}</small></span><span className="duration">{durationTimecode(line.duration)}</span></li>;
      })}
      <li className="rundown-note">Estimated. Tunarr picks the spots when the break airs.</li>
    </ol>
  );
}

function LengthEditor({ duration, disabled, onApply }: { duration: number; disabled: boolean; onApply: (ms: number) => void }) {
  const [minutes, setMinutes] = useState(Math.floor(duration / 60_000));
  const [seconds, setSeconds] = useState(Math.round((duration % 60_000) / 1000));
  const next = minutes * 60_000 + seconds * 1000;
  return (
    <form className="length-editor" onSubmit={(event) => { event.preventDefault(); if (next >= 1000) onApply(next); }}>
      <span>Length</span>
      <input type="number" min={0} step={1} aria-label="Length minutes" value={minutes} disabled={disabled} onChange={(event) => setMinutes(Math.max(0, Math.round(Number(event.target.value))))} />min
      <input type="number" min={0} max={59} step={1} aria-label="Length seconds" value={seconds} disabled={disabled} onChange={(event) => setSeconds(Math.min(59, Math.max(0, Math.round(Number(event.target.value)))))} />s
      <button type="submit" disabled={disabled || next < 1000 || next === duration}>Apply</button>
    </form>
  );
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
  const [storedAnchor, setAnchorIndex] = useState(-1);
  const [storedSelected, setSelectedIndex] = useState(-1);
  const [storedCursorStart, setCursorStart] = useState<number | null>(null);
  const [keepOnAir, setKeepOnAir] = useState(false);
  const [selectedDate, setSelectedDate] = useState(demoDate);
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState<History>(emptyHistory);
  const [base, setBase] = useState<Base | null>(null);
  const [draftMarks, setDraftMarks] = useState<Record<string, boolean>>({});
  const [slotEditor, setSlotEditor] = useState<SlotEditor>(closedSlotEditor);
  const [catalog, setCatalog] = useState<SlotCatalog | null>(null);
  const [libraryPicker, setLibraryPicker] = useState<LibraryPicker | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [listsOpen, setListsOpen] = useState<'filler' | 'custom' | null>(null);
  // Lists → Station IDs… / Commercials… open the filler lists filtered to that role.
  const [listsRole, setListsRole] = useState<FillerRole | undefined>(undefined);
  // Station-log view: each commercial break expanded into its (estimated) spots.
  const [showRundowns, setShowRundowns] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupDialog, setSetupDialog] = useState<'sources' | 'folders' | 'transcode' | 'smart' | null>(null);
  const [newChannel, setNewChannel] = useState<{ copyFrom: string } | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [grab, setGrab] = useState<Grab | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  // On narrow screens Program Info is a sheet over the lineup; this expands it.
  const [infoExpanded, setInfoExpanded] = useState(false);
  const [infoDialog, setInfoDialog] = useState<'shortcuts' | 'about' | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const programmingRequest = useRef(0);
  const guideRequest = useRef(0);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const focusCursor = useRef(false);
  const scrolledToNow = useRef('');

  const live = mode === 'live';
  const filler = useFillerSpots(live);
  // The channel's Tunarr filler lists; its station-ID lists are the IDs it airs (Channel Settings).
  const [channelFiller, setChannelFiller] = useState<{ channelId: string; listIds: string[] }>({ channelId: '', listIds: [] });
  useEffect(() => {
    if (!live || !activeChannelId) return;
    let cancelled = false;
    tunarrApi.channelSettings(activeChannelId)
      .then((settings) => { if (!cancelled) setChannelFiller({ channelId: activeChannelId, listIds: (settings.fillerCollections ?? []).map((item) => item.id) }); })
      .catch(() => { /* Falls back to every station-ID list. */ });
    return () => { cancelled = true; };
  }, [live, activeChannelId]);
  const stationIds = useMemo(() => channelStationIds(filler.stationIdsByList, channelFiller.channelId === activeChannelId ? channelFiller.listIds : []), [filler.stationIdsByList, channelFiller, activeChannelId]);
  const lineup = programming.lineup;
  const activeChannel = channels.find((channel) => channel.id === activeChannelId);
  const activeChannelIndex = channels.findIndex((channel) => channel.id === activeChannelId);
  const dirty = useMemo(() => !sameLineup(lineup, originalLineup), [lineup, originalLineup]);
  const changed = useMemo(() => (dirty ? changedPositions(lineup, originalLineup) : new Set<number>()), [dirty, lineup, originalLineup]);
  // A longer or shorter lineup moves every pass after the first. "Keep what's
  // on air in place" previews (and on save, sets) the start time that keeps
  // the pass airing now where it is; it only matters once the lineup has repeated.
  const baseLength = useMemo(() => lineupLength(base?.lineup), [base]);
  const draftLength = useMemo(() => lineupLength(lineup), [lineup]);
  const hasChannel = !!activeChannel;
  const tunarrStart = activeChannel?.startTime ?? 0;
  const generated = programming.schedule != null;
  const loopedBefore = useMemo(() => (base ? passesBefore(base.lineup, tunarrStart, now) : 0), [base, now, tunarrStart]);
  const canKeepOnAir = live && hasChannel && base?.channelId === activeChannelId && !generated && loopedBefore > 0;
  const keeping = keepOnAir && canKeepOnAir;
  /** The start time to project the lineup from, with `added` ms more in it. */
  const startWith = (added: number) => (keeping ? keptStartTime(tunarrStart, baseLength, draftLength + added, now) : tunarrStart);
  const channelStart = useMemo(() => (keeping ? keptStartTime(tunarrStart, baseLength, draftLength, now) : tunarrStart), [baseLength, draftLength, keeping, now, tunarrStart]);
  const guideIsCurrent = live && !dirty && guide?.channelId === activeChannelId && guide.date === selectedDate;
  const slotPreview = slotEditor.showingPreview && slotEditor.channelId === activeChannelId ? slotEditor.preview : null;
  const viewPrograms = useMemo(() => (slotPreview ? { ...programming.programs, ...slotPreview.programs } : programming.programs), [programming.programs, slotPreview]);
  const daySchedule = useMemo(() => {
    if (slotPreview) return scheduleForDay(null, slotPreview.lineup, slotPreview.startTime, selectedDate);
    if (!hasChannel) return { rows: [] as Instance[], guideWindow: null, guideStale: false };
    return scheduleForDay(guideIsCurrent && guide ? guide.programs : null, lineup, channelStart, selectedDate);
  }, [hasChannel, channelStart, guide, guideIsCurrent, lineup, selectedDate, slotPreview]);
  const instances = daySchedule.rows;
  const visibleInstances = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return instances;
    return instances.filter(({ item, title }) => `${title ?? programTitle(item, viewPrograms)} ${programDetail(item, viewPrograms)}`.toLowerCase().includes(query));
  }, [instances, viewPrograms, search]);
  const onAir = onAirPosition(visibleInstances, now);
  // Insert, Remove and Move act on the selection, so it must be a row on screen.
  // A channel opens with nothing picked (-1), and a picked item can air on
  // another day (on a long cycle, weeks away); until a row on screen is picked,
  // the selection is what's on air, or the day's first row.
  const storedVisible = storedSelected >= 0 && visibleInstances.some((row) => row.lineupIndex === storedSelected);
  const fallbackRow = storedVisible || grab || slotPreview ? undefined
    : (onAir >= 0 && visibleInstances[onAir].lineupIndex >= 0 ? visibleInstances[onAir] : visibleInstances.find((row) => row.lineupIndex >= 0));
  const anchorIndex = fallbackRow ? fallbackRow.lineupIndex : Math.max(storedAnchor, 0);
  const selectedIndex = fallbackRow ? fallbackRow.lineupIndex : Math.max(storedSelected, 0);
  const cursorStart = fallbackRow ? fallbackRow.start : storedCursorStart;
  const block = normalizeBlock(Math.min(anchorIndex, Math.max(lineup.length - 1, 0)), Math.min(selectedIndex, Math.max(lineup.length - 1, 0)));
  const blockSize = lineup.length ? block.end - block.start + 1 : 0;
  const inBlock = (index: number) => index >= block.start && index <= block.end && index >= 0;
  const selectedItem = lineup[selectedIndex];
  const cursorPosition = useMemo(() => {
    const exact = visibleInstances.findIndex((row) => row.lineupIndex === selectedIndex && row.start === cursorStart);
    return exact >= 0 ? exact : visibleInstances.findIndex((row) => row.lineupIndex === selectedIndex);
  }, [cursorStart, selectedIndex, visibleInstances]);
  const selectedInstance = cursorPosition >= 0 ? visibleInstances[cursorPosition] : undefined;
  const { from: dayFrom, to: dayTo } = dayRange(selectedDate);
  const dayStartMs = dayFrom.getTime();
  const dayEndMs = dayTo.getTime();
  const totals = dayTotals(instances, dayStartMs, dayEndMs);
  const kindOf = (row: Instance): AirKind => airKind(row.item, filler.spots, filler.roles);
  const kindTotals = (() => {
    const byKind: Partial<Record<AirKind, number>> = {};
    for (const row of instances) byKind[kindOf(row)] = (byKind[kindOf(row)] ?? 0) + Math.max(0, Math.min(row.stop, dayEndMs) - Math.max(row.start, dayStartMs));
    return byKind;
  })();
  const hours = hourSummaries(visibleInstances, kindOf, dayStartMs, dayEndMs);
  const canUndo = history.past.length > 0 && !grab;
  const canRedo = history.future.length > 0 && !grab;
  const describe = (target: Block = block, items: LineupItem[] = lineup) => {
    const first = items[target.start];
    const title = first ? `“${programTitle(first, programming.programs)}”` : 'selection';
    return target.end > target.start ? `${target.end - target.start + 1} items from ${title}` : title;
  };

  const notify = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? '' : current)), 3600);
  };

  const select = (index: number, start: number | null, extend = false) => {
    if (!extend) setAnchorIndex(index);
    setSelectedIndex(index);
    setCursorStart(start);
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

  const resetEditing = () => {
    setHistory(emptyHistory);
    setGrab(null);
  };

  const refreshDraftMarks = () => {
    draftStore().list().then((drafts) => setDraftMarks(Object.fromEntries(drafts.filter((draft) => draft.dirty).map((draft) => [draft.channelId, true])))).catch(() => {});
  };

  /**
   * Loads a channel. Restores a saved draft (unsaved order + undo history) if
   * one exists for this exact version, or re-attaches history after a save.
   */
  const loadProgramming = async (channelId: string, date: string, options: { keepSelection?: boolean; rebase?: { saved: LineupItem[]; history: History } } = {}) => {
    const { keepSelection = false, rebase } = options;
    const request = ++programmingRequest.current;
    setActiveChannelId(channelId);
    setLoading(true);
    setProgrammingError('');
    resetEditing();
    setKeepOnAir(false);
    if (!keepSelection) {
      setProgramming(emptyProgramming);
      setOriginalLineup([]);
      setBase(null);
      setGuide(null);
      // Nothing picked yet: the selection is what's on air (see fallbackRow).
      select(-1, null);
    }
    try {
      const data = await tunarrApi.programming(channelId);
      if (request !== programmingRequest.current) return false;
      const loaded = Array.isArray(data?.lineup) ? data.lineup : [];
      const version = programmingVersion(data?.lineup, data?.schedule);
      let current = loaded;
      let restoredHistory = emptyHistory;
      let restoredPrograms: Record<string, unknown> = {};
      let note = '';
      if (rebase) {
        const carried = rebaseHistory(rebase.history, rebase.saved, loaded);
        if (carried) restoredHistory = carried;
        else if (rebase.history.past.length || rebase.history.future.length) note = 'Saved. Tunarr adjusted the lineup, so the edit list starts fresh.';
      } else {
        const stored = await draftStore().get(channelId).catch(() => undefined);
        if (request !== programmingRequest.current) return false;
        if (stored && stored.version === version) {
          const decoded = decodeDraft(stored, loaded);
          if (decoded) {
            current = decoded.current;
            restoredHistory = decoded.history;
            restoredPrograms = decoded.programs;
            if (stored.keepOnAir) setKeepOnAir(true);
            if (stored.dirty) note = `Restored your unsaved changes (${decoded.history.past.length} ${decoded.history.past.length === 1 ? 'edit' : 'edits'}).`;
          }
        } else if (stored) {
          void draftStore().delete(channelId).catch(() => {});
          if (stored.dirty) note = 'This channel changed in Tunarr since you last edited it here, so those unsaved changes no longer apply and were dropped.';
        }
      }
      setProgramming({ ...data, lineup: current, programs: { ...restoredPrograms, ...(data?.programs ?? {}) } as Programming['programs'] });
      setOriginalLineup(structuredClone(loaded));
      setBase({ channelId, version, lineup: loaded });
      setHistory(restoredHistory);
      if (note) notify(note);
      if (keepSelection) {
        const last = Math.max(loaded.length - 1, 0);
        setAnchorIndex((value) => Math.min(value, last));
        setSelectedIndex((value) => Math.min(value, last));
      }
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
    setBase(null);
    setSlotEditor(closedSlotEditor);
    resetEditing();
    setSelectedDate(today);
    setConnectionOpen(false);
    refreshDraftMarks();
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
      refreshDraftMarks();
      void loadChannels(today);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Unsaved work survives a reload when drafts are stored; warn only when they can't be.
  useEffect(() => {
    if (!live || !dirty || draftStore().persistent) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [live, dirty]);

  // Keep this channel's draft (unsaved order + undo history) in the browser.
  useEffect(() => {
    if (!live || !base || base.channelId !== activeChannelId || loading || grab) return;
    const store = draftStore();
    const keep = dirty || history.past.length > 0 || history.future.length > 0;
    const record = keep ? { ...encodeDraft(base.channelId, base.version, base.lineup, lineup, history, dirty, programming.programs), ...(keepOnAir ? { keepOnAir: true } : {}) } : null;
    const write = record ? store.put(record) : store.delete(base.channelId);
    const channelId = base.channelId;
    write
      .then(() => setDraftMarks((marks) => (!!marks[channelId] === dirty ? marks : { ...marks, [channelId]: dirty })))
      .catch(() => {});
  }, [activeChannelId, base, dirty, grab, history, keepOnAir, lineup, live, loading, programming.programs]);

  // Follow the keyboard/remote cursor: focus the row and keep it on screen.
  useEffect(() => {
    if (!focusCursor.current || cursorPosition < 0) return;
    focusCursor.current = false;
    const row = rowRefs.current.get(cursorPosition);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: 'center' });
  }, [cursorPosition]);

  // Open today's schedule at whatever is on air, once per channel and day.
  useEffect(() => {
    const key = `${activeChannelId}|${selectedDate}`;
    if (onAir < 0 || scrolledToNow.current === key || loading) return;
    scrolledToNow.current = key;
    rowRefs.current.get(onAir)?.scrollIntoView?.({ block: 'center' });
  }, [activeChannelId, loading, onAir, selectedDate]);

  /** Demo edits are not kept, so leaving them asks first. Live drafts are stored per channel. */
  const guardUnsaved = (action: () => void) => {
    if (live || (!dirty && !grab)) {
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
    setSlotEditor(closedSlotEditor);
    setBase(null);
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
    resetEditing();
    select(5, null);
    setSelectedDate(demoDate);
    setConnectionOpen(false);
    notify('Demo mode: sample data only, nothing is sent to Tunarr');
  });

  const loadChannel = (channel: Channel) => guardUnsaved(() => {
    if (grab) cancelGrab();
    if (slotEditor.channelId && slotEditor.channelId !== channel.id) setSlotEditor(closedSlotEditor);
    if (!live) {
      const sample = demoProgramming();
      setActiveChannelId(channel.id);
      setProgramming(sample);
      setOriginalLineup(structuredClone(sample.lineup));
      resetEditing();
      select(-1, null);
      return;
    }
    void loadProgramming(channel.id, selectedDate);
  });

  const stepChannel = (direction: 1 | -1) => {
    if (!channels.length) return;
    const next = channels[(Math.max(activeChannelIndex, 0) + direction + channels.length) % channels.length];
    if (next.id !== activeChannelId) loadChannel(next);
  };

  const changeDate = (date: string) => {
    if (!date) return;
    setSelectedDate(date);
    if (live && activeChannelId && !programmingError) void loadGuide(activeChannelId, date);
  };

  const shiftDay = (amount: number) => {
    const date = new Date(`${selectedDate}T12:00:00`);
    date.setDate(date.getDate() + amount);
    changeDate(inputDate(date));
  };

  const goToNow = () => {
    const today = inputDate(new Date());
    if (selectedDate !== today) changeDate(today);
    scrolledToNow.current = '';
    if (!activeChannel) return;
    const rows = scheduleForDay(null, lineup, channelStart, today).rows;
    const row = rows[onAirPosition(rows, now)];
    if (row) {
      focusCursor.current = true;
      select(row.lineupIndex, row.start);
    }
  };

  /** Applies an edit to the lineup, records it for undo, and moves the cursor with it. */
  const applyEdit = (label: string, next: LineupItem[], nextBlock: Block) => {
    setHistory((current) => record(current, { label, before: lineup, after: next, blockBefore: block, blockAfter: nextBlock }));
    setProgramming((current) => ({ ...current, lineup: next }));
    followBlock(next, nextBlock);
    setArrangeOpen(false);
  };

  const followBlock = (next: LineupItem[], nextBlock: Block) => {
    setAnchorIndex(nextBlock.end);
    setSelectedIndex(nextBlock.start);
    if (activeChannel) setCursorStart(occurrenceStart(next, startWith(cycleDuration(next) - draftLength), nextBlock.start, selectedInstance?.start ?? dayStartMs));
    focusCursor.current = true;
  };

  const moveBefore = (target: number, source: Block = block) => {
    const result = moveBlock(lineup, source, target);
    if (result) applyEdit(`Moved ${describe(source)} to #${result.block.start + 1}`, result.lineup, result.block);
  };

  const swapWith = (target: number) => {
    const result = reorderLineup(lineup, selectedIndex, target, true);
    if (result) applyEdit(`Swapped ${describe()} with “${programTitle(lineup[target], programming.programs)}”`, result.lineup, { start: result.selectedIndex, end: result.selectedIndex });
  };

  const nudge = (direction: -1 | 1) => {
    const result = shiftBlock(lineup, block, direction);
    if (result) applyEdit(`Moved ${describe()} ${direction < 0 ? 'earlier' : 'later'}`, result.lineup, result.block);
  };

  const moveToPosition = (position: number) => {
    const result = moveBlockToPosition(lineup, block, position);
    if (result) applyEdit(`Moved ${describe()} to #${result.block.start + 1}`, result.lineup, result.block);
  };

  const moveToTime = (time: number) => {
    if (!activeChannel) return;
    const result = moveBlockToTime(lineup, block, channelStart, time);
    if (!result || result.unchanged) return;
    applyEdit(`Moved ${describe()} to start ${clockTimecode(result.start)}`, result.lineup, result.block);
    if (inputDate(new Date(result.start)) !== selectedDate) changeDate(inputDate(new Date(result.start)));
    setCursorStart(result.start);
  };

  const pickUp = () => {
    if (!selectedItem || grab) return;
    setGrab({ before: lineup, block });
  };

  const slideGrab = (direction: -1 | 1) => {
    const result = shiftBlock(lineup, block, direction);
    if (!result) return;
    setProgramming((current) => ({ ...current, lineup: result.lineup }));
    followBlock(result.lineup, result.block);
  };

  const drop = () => {
    if (!grab) return;
    if (!sameLineup(lineup, grab.before)) {
      const steps = block.start - grab.block.start;
      const label = `Moved ${describe(grab.block, grab.before)} ${Math.abs(steps)} ${Math.abs(steps) === 1 ? 'place' : 'places'} ${steps < 0 ? 'earlier' : 'later'}`;
      setHistory((current) => record(current, { label, before: grab.before, after: lineup, blockBefore: grab.block, blockAfter: block }));
    }
    setGrab(null);
  };

  const cancelGrab = () => {
    if (!grab) return;
    setProgramming((current) => ({ ...current, lineup: grab.before }));
    followBlock(grab.before, grab.block);
    setGrab(null);
  };

  const undo = () => {
    const result = undoHistory(history);
    if (!result) return;
    setHistory(result.history);
    setProgramming((current) => ({ ...current, lineup: result.entry.before }));
    followBlock(result.entry.before, result.entry.blockBefore);
    notify(`Undid: ${result.entry.label}`);
  };

  const redo = () => {
    const result = redoHistory(history);
    if (!result) return;
    setHistory(result.history);
    setProgramming((current) => ({ ...current, lineup: result.entry.after }));
    followBlock(result.entry.after, result.entry.blockAfter);
    notify(`Redid: ${result.entry.label}`);
  };

  const revertAll = () => {
    if (base && base.channelId === activeChannelId) setProgramming((current) => ({ ...current, lineup: [...base.lineup] }));
    else setProgramming((current) => ({ ...current, lineup: structuredClone(originalLineup) }));
    resetEditing();
    notify('All changes reverted');
  };

  /** Discards this channel's stored draft and reloads it from Tunarr. */
  const reloadFromTunarr = async (channelId: string) => {
    await draftStore().delete(channelId).catch(() => {});
    setDraftMarks((marks) => ({ ...marks, [channelId]: false }));
    setSlotEditor(closedSlotEditor);
    await loadProgramming(channelId, selectedDate);
  };

  const showConflict = (channelId: string, what: string) => setConfirmDialog({
    title: 'This channel changed in Tunarr',
    body: `Since you opened it, the channel was changed somewhere else, so ${what} was not saved and those changes are safe. Reload to start again from Tunarr’s current version, or keep your edits on screen.`,
    confirmLabel: 'Reload from Tunarr',
    cancelLabel: 'Keep my edits',
    onConfirm: () => void reloadFromTunarr(channelId),
  });

  const performSave = async () => {
    if (!base) return;
    const channelId = activeChannelId;
    const savedLineup = lineup;
    const savedHistory = history;
    const built = buildManualSave(savedLineup);
    const skipped = built.skipped;
    // The companion moves the start time itself, from Tunarr's current copy.
    const request = keeping && baseLength !== lineupLength(built.request.lineup) ? { ...built.request, keepOnAir: true } : built.request;
    setSaving(true);
    try {
      // The companion checks the version and writes under a per-channel lock,
      // refusing (412) if the channel changed since this lineup was loaded.
      const result = (await tunarrApi.saveProgramming(channelId, request, base.version)) as { startTime?: unknown; startTimeError?: unknown } | null;
      const movedTo = typeof result?.startTime === 'number' ? result.startTime : null;
      if (movedTo !== null) setChannels((list) => list.map((channel) => (channel.id === channelId ? { ...channel, startTime: movedTo } : channel)));
      if (typeof result?.startTimeError === 'string') notify(result.startTimeError);
      else notify(`${skipped ? `Lineup saved to Tunarr (${skipped} zero-length ${skipped === 1 ? 'item' : 'items'} left out)` : 'Lineup saved to Tunarr'}${request.keepOnAir ? '. The start time moved so what’s on air keeps its time.' : ''}`);
      // Re-read what Tunarr actually stored, and carry the edit list over to it.
      await loadProgramming(channelId, selectedDate, { keepSelection: true, rebase: { saved: request.lineup, history: savedHistory } });
      void tunarrApi.channels().then((list) => setChannels([...list].sort((a, b) => a.number - b.number))).catch(noteFailure);
    } catch (error) {
      if (error instanceof TunarrApiError && error.code === 'lineup_changed') showConflict(channelId, 'your lineup');
      else notify(`Not saved: ${errorMessage(error, 'Could not save the lineup.')}`);
      noteFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const loadCatalog = () => {
    Promise.all([tunarrApi.customShows(), tunarrApi.fillerLists(), tunarrApi.smartCollections()])
      .then(([customShows, fillerLists, smartCollections]) => setCatalog({
        customShows: customShows.map(({ id, name }) => ({ id, name })),
        fillerLists: fillerLists.map(({ id, name }) => ({ id, name })),
        smartCollections,
        channels: channels.map(({ id, name, number }) => ({ id, name, number })),
      }))
      .catch((error) => {
        // Slots can still be edited with the sources already in the schedule.
        setCatalog({ customShows: [], fillerLists: [], smartCollections: [], channels: channels.map(({ id, name, number }) => ({ id, name, number })) });
        notify(`Couldn’t load custom shows and filler lists: ${errorMessage(error, 'unknown error')}`);
        noteFailure(error);
      });
  };

  /** Opens the slot editor: the channel's schedule, or a new one for a manual channel. */
  const openSlotEditor = () => {
    if (!live || !activeChannelId) return;
    const channelId = activeChannelId;
    if (grab) cancelGrab();
    loadCatalog();
    if (slotEditor.channelId === channelId && slotEditor.loaded) {
      setSlotEditor((current) => ({ ...current, open: true, showingPreview: false }));
      return;
    }
    if (!hasGeneratedSchedule(programming)) {
      const draft = draftFromSchedule(null, 'random');
      setSlotEditor({ ...closedSlotEditor, channelId, open: true, isNew: true, loaded: true, draft, saved: null });
      return;
    }
    setSlotEditor({ ...closedSlotEditor, channelId, open: true, busy: true });
    tunarrApi.schedule(channelId)
      .then((data) => {
        const schedule = data?.schedule as SlotSchedule | undefined;
        if (!schedule || !Array.isArray(schedule.slots)) throw new Error('Tunarr returned no slot schedule for this channel.');
        const draft = draftFromSchedule(schedule);
        setSlotEditor((current) => (current.channelId === channelId ? { ...current, busy: false, loaded: true, draft, saved: structuredClone(draft) } : current));
      })
      .catch((error) => {
        setSlotEditor((current) => (current.channelId === channelId ? { ...current, busy: false, error: errorMessage(error, 'Could not load the slot schedule.') } : current));
        noteFailure(error);
      });
  };

  /** Opens a template's schedule draft in the slot editor, on this channel or a new one. */
  const applyTemplate = async (draft: ScheduleDraftState, target: TemplateTarget, template: { name: string }) => {
    let channelId = activeChannelId;
    let isNew = !hasGeneratedSchedule(programming);
    if (target.kind === 'new') {
      const created = await tunarrApi.createChannel({ name: target.name, number: target.number });
      resetEditing();
      await loadChannels(selectedDate, created.id);
      channelId = created.id;
      isNew = true;
    }
    if (grab) cancelGrab();
    loadCatalog();
    setTemplatesOpen(false);
    setSlotEditor({ ...closedSlotEditor, channelId, open: true, isNew, loaded: true, draft, saved: null });
    notify(`${template.name} template ready: preview it, then save`);
  };

  const scheduleRequest = (draft: ScheduleDraftState) => ({ type: draft.type, settings: draft.settings, slots: draft.slots, extraPrograms: draft.extraMovies.map((movie) => movie.id) });

  const previewSlots = () => {
    const { channelId, draft } = slotEditor;
    if (!channelId) return;
    setSlotEditor((current) => ({ ...current, busy: true, error: '' }));
    tunarrApi.previewSchedule(channelId, scheduleRequest(draft))
      .then((preview) => {
        setSlotEditor((current) => (current.channelId === channelId ? { ...current, busy: false, preview, previewOf: draftKey(draft), open: false, showingPreview: true } : current));
        notify('Previewing the regenerated lineup. Nothing is saved yet.');
      })
      .catch((error) => {
        setSlotEditor((current) => (current.channelId === channelId ? { ...current, busy: false, error: errorMessage(error, 'Tunarr could not generate a preview.') } : current));
        noteFailure(error);
      });
  };

  const saveSlots = () => {
    const { channelId, draft, preview } = slotEditor;
    if (!channelId || !preview || !base || slotEditor.previewOf !== draftKey(draft)) return;
    const commit = () => {
      setSlotEditor((current) => ({ ...current, busy: true, error: '' }));
      setSaving(true);
      tunarrApi.saveSchedule(channelId, scheduleRequest(draft), preview, base.version)
        .then(async (saved) => {
          await draftStore().delete(channelId).catch(() => {});
          setDraftMarks((marks) => ({ ...marks, [channelId]: false }));
          setSlotEditor(closedSlotEditor);
          // Tunarr regenerates with the preview's random seed; confirm the result matches what was shown.
          const savedKeys = (Array.isArray(saved?.lineup) ? saved.lineup : []).map(itemIdentity);
          const previewKeys = preview.lineup.map(itemIdentity);
          const differing = savedKeys.length === previewKeys.length ? savedKeys.filter((key, index) => key !== previewKeys[index]).length : Math.max(savedKeys.length, previewKeys.length);
          notify(differing
            ? `Schedule saved, but Tunarr’s result differs from the preview in ${differing} ${differing === 1 ? 'place' : 'places'}. The timeline shows what was saved.`
            : 'Schedule saved exactly as previewed. Tunarr regenerated the lineup, so the edit list starts fresh.');
          await loadProgramming(channelId, selectedDate);
          void tunarrApi.channels().then((list) => setChannels([...list].sort((a, b) => a.number - b.number))).catch(noteFailure);
        })
        .catch((error) => {
          if (error instanceof TunarrApiError && error.code === 'lineup_changed') {
            setSlotEditor((current) => ({ ...current, busy: false }));
            showConflict(channelId, 'the schedule');
          } else {
            setSlotEditor((current) => ({ ...current, busy: false, open: true, showingPreview: false, error: errorMessage(error, 'Could not save the schedule.') }));
          }
          noteFailure(error);
        })
        .finally(() => setSaving(false));
    };
    if (dirty) {
      setConfirmDialog({
        title: 'Replace your unsaved lineup edits?',
        body: 'Saving the schedule regenerates this channel’s lineup from its slots, which replaces the unsaved edits you made to the lineup.',
        confirmLabel: 'Save schedule',
        onConfirm: commit,
      });
      return;
    }
    commit();
  };

  /** Keeps the channel's current lineup as a manual lineup, so Tunarr stops generating it. */
  const detachToManual = () => {
    if (!base || !activeChannelId) return;
    const channelId = activeChannelId;
    const version = base.version;
    const { request } = buildManualSave(base.lineup);
    setConfirmDialog({
      title: 'Detach from the slot schedule?',
      body: 'The lineup Tunarr has now is kept as a manual lineup and the slot schedule is dropped. Tunarr will stop regenerating this channel. Unsaved lineup edits are not included.',
      confirmLabel: 'Detach',
      onConfirm: () => {
        setSaving(true);
        tunarrApi.saveProgramming(channelId, request, version)
          .then(async () => {
            setSlotEditor(closedSlotEditor);
            await draftStore().delete(channelId).catch(() => {});
            notify('Detached. This channel now has a manual lineup.');
            await loadProgramming(channelId, selectedDate);
          })
          .catch((error) => {
            if (error instanceof TunarrApiError && error.code === 'lineup_changed') showConflict(channelId, 'the change');
            else notify(`Not saved: ${errorMessage(error, 'Could not detach the schedule.')}`);
            noteFailure(error);
          })
          .finally(() => setSaving(false));
      },
    });
  };

  const discardSlotPreview = () => setSlotEditor((current) => ({ ...current, preview: null, previewOf: '', showingPreview: false }));

  // ------------------------------------------------------------ lineup edits

  /**
   * Where Insert puts `added` ms of new items, and when they will really air.
   * A time goes to the program boundary nearest it; before/after go next to
   * the selection. Both are worked out on the lengthened cycle (see boundaryAt).
   */
  const insertPoint = (where: InsertWhere, added: number): { index: number; start: number | null; passes: number } => {
    if (!activeChannel || !lineup.length) return { index: 0, start: null, passes: 0 };
    // `passes`: how many lineup passes grow between the fixed point (the
    // channel start, or what's on air when keeping it in place) and the spot.
    const passesTo = (time: number) => Math.abs(passesBefore(lineup, channelStart, time) - (keeping ? passesBefore(lineup, channelStart, now) : 0));
    if (typeof where === 'object') {
      const boundary = boundaryAt(lineup, startWith(added), where.at, where.snap, added);
      return boundary ? { ...boundary, passes: passesTo(where.at) } : { index: 0, start: null, passes: 0 };
    }
    const index = where === 'before' ? block.start : block.end + 1;
    const near = selectedInstance?.start ?? occurrenceStart(lineup, channelStart, block.start, dayStartMs);
    return { index, start: insertedStart(lineup, channelStart, index, near, added, startWith(added)), passes: passesTo(near) };
  };

  const insertAt = (where: InsertWhere, items: LineupItem[], label: string, meta: Record<string, ContentProgram> = {}) => {
    const point = insertPoint(where, cycleDuration(items));
    const result = insertItems(lineup, point.index, items);
    if (!result) return;
    if (Object.keys(meta).length) setProgramming((current) => ({ ...current, programs: { ...current.programs, ...meta } as Programming['programs'] }));
    applyEdit(`Inserted ${label}${point.start !== null ? ` at ${clockTimecode(point.start)}` : ''}`, result.lineup, result.block);
    // Show the day it airs and select it there.
    if (point.start !== null) {
      const day = inputDate(new Date(point.start));
      if (day !== selectedDate) changeDate(day);
      setCursorStart(point.start);
    }
    setInsertOpen(false);
  };

  /** Opens every commercial break with a rotating station ID (one undoable edit). */
  const openBreaksWithStationIds = () => {
    if (grab || slotPreview) return;
    if (!stationIds.ids.length) {
      notify('No station IDs yet. Tag a filler list as Station IDs in Lists → Station IDs…');
      return;
    }
    const result = openBreaksWithIds(lineup, stationIds.ids, (item) => !!item.id && filler.spots.get(item.id) === 'station-id');
    if (!result) {
      notify('Every commercial break already opens with a station ID.');
      return;
    }
    setProgramming((current) => ({ ...current, programs: { ...current.programs, ...Object.fromEntries(stationIds.ids.map((program) => [program.id, program])) } as Programming['programs'] }));
    applyEdit(`Opened ${result.added} ${result.added === 1 ? 'break' : 'breaks'} with ${stationIds.own ? 'this channel’s station IDs' : 'a station ID'}`, result.lineup, { start: block.start, end: block.start });
  };

  /** Puts a date-specific event into the lineup and shows the day it airs. */
  const placeEventEdit = (placement: EventPlacement, label: string, meta: Record<string, ContentProgram>, date: string) => {
    if (Object.keys(meta).length) setProgramming((current) => ({ ...current, programs: { ...current.programs, ...meta } as Programming['programs'] }));
    applyEdit(`Scheduled “${label}” for ${date}`, placement.lineup, { start: placement.index, end: placement.index + placement.count - 1 });
    setEventOpen(false);
    changeDate(date);
    setCursorStart(placement.start);
  };

  const removeSelection = () => {
    if (!selectedItem || grab) return;
    const result = removeBlock(lineup, block);
    if (result) applyEdit(`Removed ${describe()}`, result.lineup, result.block);
  };

  const changeLength = (duration: number) => {
    if (blockSize !== 1 || grab) return;
    const next = setItemDuration(lineup, selectedIndex, duration);
    if (next) applyEdit(`Changed ${describe()} to ${durationTimecode(duration)}`, next, block);
  };

  const pickFromLibrary = (pick: LibraryPick) => {
    const picker = libraryPicker;
    setLibraryPicker(null);
    if (!picker) return;
    if (picker.purpose === 'insert' && 'programs' in pick) {
      const programs = pick.programs.filter((program) => program.duration > 0);
      if (!programs.length) return;
      const entries = programs.map(lineupEntry);
      insertAt(picker.where, entries.map((entry) => entry.item), insertedLabel(programs), Object.fromEntries(entries.map((entry) => entry.meta)));
    } else if (picker.purpose === 'slot-show' && 'show' in pick) {
      setSlotEditor((current) => {
        const option = showOption(pick.show);
        const slots = picker.index === null
          ? [...current.draft.slots, newSlot(current.draft, option)]
          : current.draft.slots.map((slot, index) => (index === picker.index ? changeSlotSource(slot, option) : slot));
        return { ...current, draft: { ...current.draft, slots } };
      });
    } else if (picker.purpose === 'movies' && 'programs' in pick) {
      setSlotEditor((current) => {
        const known = new Set(current.draft.extraMovies.map((movie) => movie.id));
        const added = pick.programs.filter((program) => !known.has(program.id)).map((program) => ({ id: program.id, title: String((program.program as { title?: string }).title ?? 'Movie') }));
        return { ...current, draft: { ...current.draft, extraMovies: [...current.draft.extraMovies, ...added] } };
      });
    }
  };


  const save = () => {
    if (!dirty || saving || grab) return;
    if (!live) {
      setOriginalLineup(structuredClone(lineup));
      resetEditing();
      notify('Demo changes saved for this session');
      return;
    }
    if (!activeChannelId || loading) return;
    if (hasGeneratedSchedule(programming)) {
      setConfirmDialog({
        title: 'Save over a generated schedule?',
        body: `Tunarr builds this channel’s lineup from ${scheduleSummary(programming.schedule)}. Saving replaces the generated lineup with your edited copy. Tunarr keeps the slot schedule, so your changes last until the lineup is regenerated (by saving the slot schedule or changing the channel’s start time).`,
        confirmLabel: 'Save manual lineup',
        onConfirm: () => void performSave(),
      });
      return;
    }
    void performSave();
  };

  const reloadChannel = () => {
    if (!live || !activeChannelId) return;
    const channelId = activeChannelId;
    if (!dirty) {
      void reloadFromTunarr(channelId);
      return;
    }
    setConfirmDialog({
      title: 'Discard unsaved changes?',
      body: 'Reloading starts again from Tunarr’s current lineup. Your unsaved changes and edit list for this channel will be discarded.',
      confirmLabel: 'Discard and reload',
      onConfirm: () => void reloadFromTunarr(channelId),
    });
  };

  const retry = () => {
    if (channelsError || !channels.length) void loadChannels(selectedDate, activeChannelId);
    else if (activeChannelId) void loadProgramming(activeChannelId, selectedDate);
  };

  const exportLog = () => {
    if (!activeChannel || !instances.length) return;
    const rows = instances.map((row) => [
      selectedDate,
      clockTimecode(row.start),
      clockTimecode(row.stop),
      durationTimecode(row.stop - row.start),
      row.item.type,
      row.title ?? programTitle(row.item, programming.programs),
      row.lineupIndex < 0 ? 'In Tunarr’s guide only' : programDetail(row.item, programming.programs),
      row.lineupIndex < 0 ? '' : row.lineupIndex + 1,
    ]);
    const csv = toCsv(['Date', 'Start', 'End', 'Duration', 'Type', 'Title', 'Detail', 'Lineup position'], rows);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `program-log-ch${activeChannel.number}-${selectedDate}${dirty ? '-unsaved' : ''}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify(`Exported ${rows.length} log entries`);
  };

  const moveCursor = (direction: -1 | 1, extend: boolean) => {
    if (!visibleInstances.length) return;
    let position = cursorPosition < 0 ? (onAir >= 0 ? onAir : 0) - direction : cursorPosition;
    do position += direction;
    while (position >= 0 && position < visibleInstances.length && visibleInstances[position].lineupIndex < 0);
    const row = visibleInstances[position];
    if (!row) return;
    // A block must stay contiguous in the lineup, so stop extending across a cycle wrap.
    if (extend && Math.abs(row.lineupIndex - selectedIndex) !== 1) return;
    focusCursor.current = true;
    select(row.lineupIndex, row.start, extend);
  };

  // On phones the channel rail is a horizontal strip; keep the active channel in view.
  useEffect(() => {
    document.querySelector('.channel-rail .channel.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeChannelId]);

  // Keyboard and TV-remote control. Arrow keys map to a remote's D-pad,
  // Enter to OK, Escape/Back to Back, PageUp/PageDown to CH+/CH−.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key;
      const back = key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
      const mod = event.metaKey || event.ctrlKey;
      if (confirmDialog || arrangeOpen || connectionOpen || infoDialog || slotEditor.open || libraryPicker || insertOpen || settingsOpen || listsOpen || setupDialog || newChannel || templatesOpen || eventOpen) {
        if (!back) return;
        event.preventDefault();
        if (confirmDialog) setConfirmDialog(null);
        else if (libraryPicker) setLibraryPicker(null);
        else if (insertOpen) setInsertOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (listsOpen) setListsOpen(null);
        else if (setupDialog) setSetupDialog(null);
        else if (newChannel) setNewChannel(null);
        else if (templatesOpen) setTemplatesOpen(false);
        else if (eventOpen) setEventOpen(false);
        else if (slotEditor.open) setSlotEditor((current) => ({ ...current, open: false }));
        else if (arrangeOpen) setArrangeOpen(false);
        else if (infoDialog) setInfoDialog(null);
        else setConnectionOpen(false);
        return;
      }
      if (event.altKey || isTypingTarget(event.target)) return;
      if ((event.target as HTMLElement | null)?.closest?.('[role="menubar"]')) return;
      if (mod) {
        const lower = key.toLowerCase();
        if (lower === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
        else if (lower === 'y') { event.preventDefault(); redo(); }
        else if (lower === 's') { event.preventDefault(); save(); }
        return;
      }
      const onRow = (event.target as HTMLElement | null)?.classList?.contains('program') || event.target === document.body;
      if (slotPreview && !['ArrowLeft', 'ArrowRight', 'n', 't', 'b', '?'].includes(key) && !back) return;
      if (slotPreview && back) { event.preventDefault(); discardSlotPreview(); return; }
      switch (key) {
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault();
          if (grab) slideGrab(key === 'ArrowDown' ? 1 : -1);
          else moveCursor(key === 'ArrowDown' ? 1 : -1, event.shiftKey);
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
          if (grab || !onRow) return;
          event.preventDefault();
          shiftDay(key === 'ArrowRight' ? 1 : -1);
          break;
        case 'PageUp':
        case 'PageDown':
        case 'ChannelUp':
        case 'ChannelDown':
          if (grab) return;
          event.preventDefault();
          stepChannel(key === 'PageUp' || key === 'ChannelUp' ? -1 : 1);
          break;
        case 'Enter':
        case ' ':
          if (!onRow || !selectedItem) return;
          event.preventDefault();
          if (grab) drop();
          else pickUp();
          break;
        default:
          if (back) {
            if (grab) { event.preventDefault(); cancelGrab(); }
            else if (blockSize > 1) { event.preventDefault(); select(selectedIndex, cursorStart); }
          } else if (!grab && key === 'n') goToNow();
          else if (!grab && key === 't') changeDate(inputDate(new Date()));
          else if (key === 'b') setShowRundowns((open) => !open);
          else if (!grab && key === 'm' && selectedItem) setArrangeOpen(true);
          else if (!grab && !slotPreview && key === 'i' && activeChannel) setInsertOpen(true);
          else if (!grab && !slotPreview && key === 'e' && activeChannel && lineup.length) setEventOpen(true);
          else if (!grab && key === 'Delete' && selectedItem) { event.preventDefault(); removeSelection(); }
          else if (key === '?') setInfoDialog('shortcuts');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const confirmDeleteChannel = () => {
    const channel = activeChannel;
    if (!channel) return;
    setConfirmDialog({
      title: `Delete CH ${channel.number} ${channel.name}?`,
      body: `Tunarr removes the channel, its lineup and its schedule${dirty ? ', and your unsaved edits are lost' : ''}. Programs stay in your libraries. This can’t be undone.`,
      confirmLabel: 'Delete channel',
      onConfirm: () => {
        setSaving(true);
        tunarrApi.deleteChannel(channel.id)
          .then(() => {
            notify(`Deleted CH ${channel.number} ${channel.name}`);
            resetEditing();
            setSlotEditor(closedSlotEditor);
            const index = channels.findIndex((item) => item.id === channel.id);
            const neighbour = channels[index + 1] ?? channels[index - 1];
            return loadChannels(selectedDate, neighbour?.id);
          })
          .catch((error) => { notify(errorMessage(error, 'The channel was not deleted.')); noteFailure(error); })
          .finally(() => setSaving(false));
      },
    });
  };

  const menus: Menu[] = [
    { title: 'File', items: [
      { label: 'Save Lineup', shortcut: '⌘S', disabled: !dirty || saving || !!grab, onSelect: save },
      { label: 'Export Program Log…', disabled: !instances.length, onSelect: exportLog },
      'separator',
      { label: 'Reload From Tunarr', disabled: !live || !activeChannelId, onSelect: reloadChannel },
      { label: 'Connection…', onSelect: () => setConnectionOpen(true) },
      live ? { label: 'Use Demo Data', onSelect: switchToDemo } : { label: 'Connect to Tunarr', onSelect: () => guardUnsaved(() => void goLive()) },
    ] },
    { title: 'Edit', items: [
      { label: canUndo ? `Undo ${history.past.at(-1)!.label}` : 'Undo', shortcut: '⌘Z', disabled: !canUndo, onSelect: undo },
      { label: canRedo ? `Redo ${history.future[0].label}` : 'Redo', shortcut: '⇧⌘Z', disabled: !canRedo, onSelect: redo },
      { label: 'Revert All Changes', disabled: !dirty || !!grab, onSelect: revertAll },
      'separator',
      { label: 'Insert…', shortcut: 'I', disabled: !activeChannel || !!grab || !!slotPreview, onSelect: () => setInsertOpen(true) },
      { label: 'Schedule Event…', shortcut: 'E', disabled: !activeChannel || !lineup.length || !!grab || !!slotPreview, onSelect: () => setEventOpen(true) },
      { label: 'Open Breaks With Station IDs', disabled: !live || !activeChannel || !lineup.length || !!grab || !!slotPreview, onSelect: openBreaksWithStationIds },
      { label: 'Remove', shortcut: 'Del', disabled: !selectedItem || !!grab || !!slotPreview, onSelect: removeSelection },
      { label: 'Move or Swap…', shortcut: 'M', disabled: !selectedItem || !!grab, onSelect: () => setArrangeOpen(true) },
      { label: grab ? 'Drop Here' : 'Pick Up to Slide', shortcut: 'OK', disabled: !selectedItem, onSelect: () => (grab ? drop() : pickUp()) },
      { label: 'Move Earlier', shortcut: '↑', disabled: !selectedItem || block.start === 0 || !!grab, onSelect: () => nudge(-1) },
      { label: 'Move Later', shortcut: '↓', disabled: !selectedItem || block.end >= lineup.length - 1 || !!grab, onSelect: () => nudge(1) },
    ] },
    { title: 'View', items: [
      { label: 'Go to Now', shortcut: 'N', disabled: !activeChannel, onSelect: goToNow },
      { label: 'Today', shortcut: 'T', onSelect: () => changeDate(inputDate(new Date())) },
      { label: showRundowns ? 'Hide Break Rundowns' : 'Show Break Rundowns', shortcut: 'B', onSelect: () => setShowRundowns((open) => !open) },
      { label: 'Previous Day', shortcut: '←', onSelect: () => shiftDay(-1) },
      { label: 'Next Day', shortcut: '→', onSelect: () => shiftDay(1) },
    ] },
    { title: 'Channel', items: [
      { label: 'Previous Channel', shortcut: 'CH−', disabled: channels.length < 2, onSelect: () => stepChannel(-1) },
      { label: 'Next Channel', shortcut: 'CH+', disabled: channels.length < 2, onSelect: () => stepChannel(1) },
      { label: 'Reload Channel', disabled: !live || !activeChannelId, onSelect: reloadChannel },
      'separator',
      { label: hasGeneratedSchedule(programming) ? 'Edit Slot Schedule…' : 'Create Slot Schedule…', disabled: !live || !activeChannelId || !!grab, onSelect: openSlotEditor },
      { label: 'Channel Settings…', disabled: !live || !activeChannelId, onSelect: () => setSettingsOpen(true) },
      { label: 'Programming Templates…', disabled: !live || !!grab, onSelect: () => { loadCatalog(); setTemplatesOpen(true); } },
      'separator',
      { label: 'New Channel…', disabled: !live || !!grab, onSelect: () => guardUnsaved(() => setNewChannel({ copyFrom: '' })) },
      { label: 'Duplicate Channel…', disabled: !live || !activeChannelId || !!grab, onSelect: () => guardUnsaved(() => setNewChannel({ copyFrom: activeChannelId })) },
      { label: 'Delete Channel…', disabled: !live || !activeChannel || !!grab, onSelect: confirmDeleteChannel },
    ] },
    { title: 'Lists', items: [
      { label: 'Station IDs…', disabled: !live, onSelect: () => { setListsRole('station-id'); setListsOpen('filler'); } },
      { label: 'Commercials…', disabled: !live, onSelect: () => { setListsRole('commercials'); setListsOpen('filler'); } },
      { label: 'Filler Lists…', disabled: !live, onSelect: () => { setListsRole(undefined); setListsOpen('filler'); } },
      { label: 'Custom Shows…', disabled: !live, onSelect: () => setListsOpen('custom') },
      { label: 'Smart Collections…', disabled: !live, onSelect: () => setSetupDialog('smart') },
    ] },
    { title: 'Setup', items: [
      { label: 'Media Sources…', disabled: !live, onSelect: () => setSetupDialog('sources') },
      { label: 'Filler Folders…', disabled: !live, onSelect: () => setSetupDialog('folders') },
      { label: 'Transcode Profiles…', disabled: !live, onSelect: () => setSetupDialog('transcode') },
    ] },
    { title: 'Help', items: [
      { label: 'Keyboard & Remote Shortcuts', shortcut: '?', onSelect: () => setInfoDialog('shortcuts') },
      { label: 'About Tunarr Lineup', onSelect: () => setInfoDialog('about') },
    ] },
  ];

  const selectedTitle = blockSize > 1 ? `${blockSize} programs selected` : selectedItem ? programTitle(selectedItem, programming.programs) : 'Nothing selected';
  const selectedDetail = blockSize > 1
    ? `${durationTimecode(lineup.slice(block.start, block.end + 1).reduce((sum, item) => sum + Math.max(0, item.duration || 0), 0))} total`
    : selectedItem ? `${programDetail(selectedItem, programming.programs)} · ${durationTimecode(selectedItem.duration)}` : '';
  const nextStationId = pickStationId(stationIds.ids, lineup);
  const selectedKind: AirKind = selectedItem ? airKind(selectedItem, filler.spots, filler.roles) : 'program';
  const selectedArt = blockSize === 1 && selectedItem ? programArtwork(selectedItem, programming.programs, live) : undefined;
  const lastRowOfBlock = blockSize > 1 ? visibleInstances.find((row) => row.lineupIndex === block.end && selectedInstance && row.start >= selectedInstance.start) : selectedInstance;
  const busy = loading || channelsLoading || guideLoading;
  const connectionClass = live && connection.status === 'connected' ? 'live' : live && connection.status !== 'checking' ? 'offline' : '';

  let sourceNote = '';
  if (slotPreview) sourceNote = '';
  else if (!live) sourceNote = 'Demo data. Changes stay in this browser session and are never sent to Tunarr.';
  else if (grab) sourceNote = 'Moving: use ↑ ↓ to slide, OK to drop, Back to cancel.';
  else if (dirty) sourceNote = 'Showing unsaved changes. Times are projected from the lineup until you save.';
  else if (guideError) sourceNote = `Tunarr’s guide for this date did not load (${guideError}). Times are projected from the lineup.`;
  else if (guideIsCurrent && lineup.length) {
    const guideWindow = daySchedule.guideWindow;
    if (daySchedule.guideStale) sourceNote = 'Tunarr’s guide does not match this lineup yet (it may still be rebuilding). Times are projected from the lineup.';
    else if (!guideWindow) sourceNote = 'Tunarr’s guide does not reach this date yet. Times are projected from the lineup.';
    else if (guideWindow.start > dayStartMs || guideWindow.stop < dayEndMs) {
      sourceNote = `Times from ${clockTimecode(Math.max(guideWindow.start, dayStartMs)).slice(0, 5)} to ${clockTimecode(Math.min(guideWindow.stop, dayEndMs)).slice(0, 5)} come from Tunarr’s guide; the rest of the day is projected from the lineup.`;
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
    } else if (!lineup.length) {
      emptyTitle = 'No programming yet';
      emptyText = 'This channel has nothing scheduled in Tunarr.';
    }
  }

  return (
    <main className={`app-shell ${grab ? 'grabbing' : ''}`}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark"></span><span className="brand-name">Tunarr Lineup</span><MenuBar menus={menus} /></div>
        <div className="top-actions">
          {canUndo && <button className="quiet" onClick={undo}>Undo</button>}
          <button className={`connection ${connectionClass}`} onClick={() => setConnectionOpen(true)} aria-label={connectionLabel(mode, connection)}><span className="status-dot" /><span className="connection-label">{connectionLabel(mode, connection)}</span></button>
          <button className="primary save" disabled={!dirty || saving || loading || !!grab} onClick={save}>{saving ? 'Saving…' : dirty ? 'Save lineup' : 'Saved'}</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="channel-rail">
          <div className="rail-heading"><p className="eyebrow">{live ? 'CHANNELS' : 'DEMO CHANNELS'}</p><span>{channels.length}</span></div>
          {channels.map((channel) => (
            <button className={`channel ${channel.id === activeChannelId ? 'active' : ''}`} key={channel.id} onClick={() => loadChannel(channel)}>
              <ChannelLogo channel={channel} live={live} />
              <span className="channel-copy"><b>{channel.name}</b><small>CH {channel.number} · {channel.programCount ?? '—'} programs{live && draftMarks[channel.id] && <em className="unsaved-mark"> · unsaved</em>}</small></span>
            </button>
          ))}
          <div className="rail-note">
            {live ? <><b>Programming desk.</b><span>Rearrange, insert, schedule and add commercials. Every change is saved through Tunarr.</span></> : <><b>Sample data.</b><span>Demo mode never reads from or writes to Tunarr.</span></>}
          </div>
        </aside>

        <section className="schedule" aria-busy={busy}>
          <div className="schedule-head">
            <div className="head-main">
              {activeChannel && channelLogoUrl(activeChannel, live) && <ChannelLogo key={activeChannel.id} channel={activeChannel} live={live} className="head-logo" />}
              <div>
              <p className="eyebrow">{activeChannel ? `${live ? '' : 'DEMO · '}${activeChannel.name.toUpperCase()} · CH ${activeChannel.number}${lineup.length ? ` · ${lineup.length.toLocaleString('en')} ITEMS · CYCLE ${durationTimecode(cycleDuration(lineup))}` : ''}` : live ? 'TUNARR' : 'DEMO'}</p>
              <h1>{dateLabel(selectedDate)}</h1>
              <p className="subtle">Seek by date, then drag, move, or swap anything already in this lineup. Press ? for remote shortcuts.</p>
              {sourceNote && <p className="subtle source-note">{sourceNote}</p>}
              </div>
            </div>
            <div className="date-controls">
              <div className="stepper"><button aria-label="Previous day" onClick={() => shiftDay(-1)}>←</button><button onClick={() => changeDate(inputDate(new Date()))}>Today</button><button aria-label="Next day" onClick={() => shiftDay(1)}>→</button></div>
              <button className="now-button" onClick={goToNow} disabled={!activeChannel}><span className="on-air-dot" />Now</button>
              <label className="date-picker"><span>Jump to date</span><input type="date" value={selectedDate} onChange={(event) => changeDate(event.target.value)} /></label>
            </div>
          </div>

          <div className="schedule-tools">
            <label className="search"><span>⌕</span><input aria-label="Search this day" placeholder="Search this day" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch('')}>×</button>}</label>
            <span className="day-count">{visibleInstances.length} {visibleInstances.length === 1 ? 'program' : 'programs'}</span>
          </div>
          {totals.total > 0 && <DayStrip
            segments={stripSegments(instances, kindOf, dayStartMs, dayEndMs)}
            from={dayStartMs}
            to={dayEndMs}
            now={now}
            totals={kindTotals}
            onPick={(position) => {
              const row = instances[position];
              if (!row) return;
              if (search) setSearch('');
              if (row.lineupIndex >= 0 && !slotPreview) select(row.lineupIndex, row.start);
              focusCursor.current = true;
            }}
          />}

          {slotPreview && <div className="preview-bar" role="region" aria-label="Schedule preview">
            <span><b>Schedule preview</b> Tunarr regenerated {slotPreview.lineup.length.toLocaleString('en')} lineup items from your edited slots. Nothing is saved yet.</span>
            <span className="preview-actions">
              <button onClick={() => setSlotEditor((current) => ({ ...current, open: true, showingPreview: false }))}>Edit slots</button>
              <button onClick={discardSlotPreview}>Discard preview</button>
              <button className="primary" disabled={slotEditor.busy || saving} onClick={saveSlots}>{slotEditor.busy ? 'Saving…' : 'Save schedule'}</button>
            </span>
          </div>}
          <div className={`timeline ${busy ? 'loading' : ''}`}>
            {!visibleInstances.length && <div className="empty"><span>○</span><h2>{emptyTitle}</h2><p>{emptyText}</p>{emptyRetry && <button onClick={retry}>Try again</button>}</div>}
            {visibleInstances.map((instance, position) => {
              const period = dayPeriod(instance.start);
              const showPeriod = position === 0 || dayPeriod(visibleInstances[position - 1].start) !== period;
              const guideOnly = instance.lineupIndex < 0;
              const readOnly = guideOnly || !!slotPreview;
              const kind = kindOf(instance);
              const previous = position > 0 ? visibleInstances[position - 1] : undefined;
              const title = instance.title ?? programTitle(instance.item, viewPrograms);
              const detail = guideOnly ? `${kind === 'program' ? instance.item.type : KIND_LABELS[kind]} · added by Tunarr (guide only)` : programDetail(instance.item, viewPrograms);
              const art = guideOnly || kind !== 'program' ? undefined : programArtwork(instance.item, viewPrograms, live, 'thumbnail');
              const hourStart = new Date(instance.start).setMinutes(0, 0, 0);
              const showHour = !previous || new Date(previous.start).setMinutes(0, 0, 0) !== hourStart;
              const hour = showHour ? hours.get(Math.max(hourStart, dayStartMs)) : undefined;
              const rundown = showRundowns && kind === 'break'
                ? estimateBreakFill(instance.item, instance.stop - instance.start, filler.listSpots, instance.start, !!previous && kindOf(previous) === 'station-id')
                : null;
              const isOnAir = position === onAir;
              const progress = isOnAir ? Math.min(100, Math.max(0, ((now - instance.start) / (instance.stop - instance.start)) * 100)) : 0;
              const classes = [
                'program',
                !readOnly && inBlock(instance.lineupIndex) ? 'selected' : '',
                slotPreview ? 'previewing' : '',
                position === cursorPosition ? 'cursor' : '',
                isOnAir ? 'on-air' : '',
                !readOnly && changed.has(instance.lineupIndex) ? 'changed' : '',
                grab && inBlock(instance.lineupIndex) ? 'grabbed' : '',
                `kind-${kind}`,
                guideOnly ? 'guide-only' : '',
              ].filter(Boolean).join(' ');
              return (
                <Fragment key={`${instance.start}-${instance.lineupIndex}`}>
                  {showPeriod && <div className="timeline-label"><span>{period}</span><i /></div>}
                  {hour && <HourLog start={hourStart} summary={hour.byKind} />}
                  <button
                    ref={(element) => { if (!element) return; rowRefs.current.set(position, element); return () => { if (rowRefs.current.get(position) === element) rowRefs.current.delete(position); }; }}
                    className={classes}
                    disabled={guideOnly}
                    aria-disabled={slotPreview ? true : undefined}
                    aria-current={isOnAir ? 'time' : undefined}
                    onClick={(event) => { if (!slotPreview) select(instance.lineupIndex, instance.start, event.shiftKey); }}
                    draggable={!readOnly && !grab}
                    onDragStart={() => setDraggedIndex(instance.lineupIndex)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggedIndex != null && !readOnly) moveBefore(instance.lineupIndex, inBlock(draggedIndex) ? block : { start: draggedIndex, end: draggedIndex });
                      setDraggedIndex(null);
                    }}
                  >
                    <time>{clockTimecode(instance.start)}{isOnAir && <em className="on-air-tag">ON AIR</em>}</time>
                    {kind === 'program' ? <ArtTile className="art" tone={artTone(instance.lineupIndex)} title={title} src={art} /> : <span className={`art kind-tile kind-${kind}`} aria-hidden="true">{KIND_GLYPHS[kind]}</span>}
                    <span className="program-copy"><b>{KIND_BADGES[kind] && <em className="kind-badge">{KIND_BADGES[kind]}</em>}{title}</b><small>{detail}</small></span>
                    <span className="duration">{durationTimecode(instance.stop - instance.start)}</span><span className="grip" aria-hidden="true">{grab && inBlock(instance.lineupIndex) ? '⇕' : '⠿'}</span>
                    {isOnAir && <i className="now-line" style={{ top: `${progress}%` }} aria-hidden="true" />}
                  </button>
                  {rundown && <BreakRundown start={instance.start} lines={rundown} />}
                </Fragment>
              );
            })}
          </div>
        </section>

        <aside className={`inspector ${infoExpanded ? 'expanded' : ''}`}>
          <button className="sheet-toggle" aria-expanded={infoExpanded} aria-label={infoExpanded ? 'Hide details' : 'Show details'} onClick={() => setInfoExpanded((open) => !open)}>{slotPreview ? 'Schedule Preview' : 'Program Info'}<span aria-hidden="true">{infoExpanded ? '▾' : '▴'}</span></button>
          <p className="eyebrow">{slotPreview ? 'SCHEDULE PREVIEW' : blockSize > 1 ? 'SELECTED BLOCK' : 'SELECTED PROGRAM'}</p>
          {slotPreview ? <>
            <span className="type-chip">{slotEditor.draft.type === 'time' ? 'time slots' : 'random slots'}</span>
            <h2>Regenerated lineup</h2>
            <p className="subtle inspector-detail">Not saved yet. Browse any day to check it, then save or go back to the slots.</p>
            <div className="info-row"><span>Lineup items</span><b>{slotPreview.lineup.length.toLocaleString('en')}</b></div>
            <div className="info-row"><span>Cycle</span><b>{durationTimecode(cycleDuration(slotPreview.lineup))}</b></div>
            <div className="info-row"><span>Slots</span><b>{slotEditor.draft.slots.length}</b></div>
            <div className="primary-actions">
              <button className="wide primary" disabled={slotEditor.busy || saving} onClick={saveSlots}>Save schedule</button>
              <button className="wide" onClick={() => setSlotEditor((current) => ({ ...current, open: true, showingPreview: false }))}>Edit slots</button>
              <button className="wide" onClick={discardSlotPreview}>Discard preview</button>
            </div>
            <p className="hint">Back closes the preview. The edited slots are kept until you leave this channel.</p>
          </> : selectedItem ? <>
            <ArtTile className="poster" tone={artTone(selectedIndex)} title={selectedTitle} src={selectedArt} />
            <span className="type-chip">{blockSize > 1 ? 'block' : selectedKind === 'program' ? selectedItem.type : KIND_LABELS[selectedKind].replace(/s$/, '')}</span>{grab && <span className="type-chip moving-chip">moving</span>}
            <h2>{selectedTitle}</h2>
            <p className="subtle inspector-detail">{selectedDetail}</p>
            <div className="info-row"><span>Starts</span><b>{selectedInstance ? fullTimeLabel(selectedInstance.start) : 'Repeating lineup'}</b></div>
            <div className="info-row"><span>Ends</span><b>{lastRowOfBlock ? clockTimecode(lastRowOfBlock.stop) : '—'}</b></div>
            <div className="info-row"><span>Position</span><b>#{block.start + 1}{blockSize > 1 ? `–${block.end + 1}` : ''} of {lineup.length}</b></div>
            {selectedInstance && cursorPosition === onAir && <div className="info-row on-air-row"><span>On air</span><b>{durationTimecode(selectedInstance.stop - now)} left</b></div>}
            <div className="nudge-row order-row"><button disabled={block.start === 0 || !!grab} onClick={() => nudge(-1)}>↑ Earlier</button><button disabled={block.end >= lineup.length - 1 || !!grab} onClick={() => nudge(1)}>↓ Later</button></div>
            <div className="primary-actions">
              <button className="wide primary" disabled={!!grab} onClick={() => setArrangeOpen(true)}>Move or swap…</button>
              <div className="nudge-row action-row"><button disabled={!!grab || !!slotPreview} onClick={() => setInsertOpen(true)}>Insert…</button><button disabled={!!grab} onClick={removeSelection}>Remove</button></div>
            </div>
            {blockSize === 1 && hasAdjustableLength(selectedItem) && <LengthEditor key={`${selectedIndex}-${selectedItem.duration}`} duration={selectedItem.duration} disabled={!!grab} onApply={changeLength} />}
            <button className="wide pickup" onClick={() => (grab ? drop() : pickUp())}>{grab ? 'Drop here' : 'Pick up to slide'}</button>
            <p className="hint">{grab ? 'Use ↑ ↓ to slide, OK to drop, Back to cancel.' : <><span className="pointer-only">Tip: drag a row, Shift-click to select a block, or press OK on a row to pick it up.</span><span className="touch-only">Tip: Earlier and Later move it one place; Move or swap… sends it anywhere.</span></>}</p>
            {hasGeneratedSchedule(programming) && <div className="warning"><b>Generated schedule</b><span>Tunarr builds this lineup from {scheduleSummary(programming.schedule)} and may regenerate over manual changes. Edit the slots to change it at the source.</span>{live && <button className="wide" disabled={!!grab} onClick={openSlotEditor}>Edit slot schedule…</button>}</div>}
            {(history.past.length > 0 || history.future.length > 0 || dirty) && <div className="edit-list">
              <p className="eyebrow">EDIT LIST{history.past.length ? ` (${history.past.length})` : ''}</p>
              <ol>
                {history.past.slice(-8).reverse().map((entry, index) => <li key={`${history.past.length - index}`}>{entry.label}</li>)}
                {!history.past.length && dirty && <li>Unsaved changes</li>}
              </ol>
              {canKeepOnAir && baseLength !== draftLength && <label className="keep-on-air"><input type="checkbox" checked={keepOnAir} onChange={(event) => setKeepOnAir(event.target.checked)} /> Keep what’s on air in place</label>}
              <div className="edit-actions">
                <button disabled={!canUndo} onClick={undo}>Undo</button>
                <button disabled={!canRedo} onClick={redo}>Redo</button>
                <button disabled={!dirty || !!grab} onClick={revertAll}>Revert all</button>
              </div>
            </div>}
          </> : <>
            <p className="subtle">{lineup.length ? 'Choose a program to adjust it.' : 'This lineup is empty.'}</p>
            {activeChannel && <button className="wide primary" disabled={!!slotPreview} onClick={() => setInsertOpen(true)}>Insert…</button>}
          </>}
        </aside>
      </div>

      {connectionOpen && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setConnectionOpen(false); }}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title">
          <button className="modal-close" aria-label="Close" onClick={() => setConnectionOpen(false)}>×</button>
          <p className="eyebrow">YOUR EXISTING SERVER</p>
          {!live ? <>
            <h2 id="connect-title">Demo mode</h2>
            <p className="subtle">You are looking at sample channels. Nothing here is read from or written to Tunarr.</p>
            <button className="wide primary connect-button" disabled={connection.status === 'checking'} onClick={() => guardUnsaved(() => void goLive())}>{connection.status === 'checking' ? 'Checking…' : 'Connect to Tunarr'}</button>
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
            <button autoFocus onClick={() => setConfirmDialog(null)}>{confirmDialog.cancelLabel ?? 'Cancel'}</button>
            <button className="primary" onClick={() => { const action = confirmDialog.onConfirm; setConfirmDialog(null); action(); }}>{confirmDialog.confirmLabel}</button>
          </div>
        </section>
      </div>}

      {infoDialog && <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInfoDialog(null); }}>
        <section className={`modal ${infoDialog === 'shortcuts' ? 'shortcuts-modal' : 'about-modal'}`} role="dialog" aria-modal="true" aria-labelledby="info-title">
          <button className="modal-close" aria-label="Close" onClick={() => setInfoDialog(null)}>×</button>
          {infoDialog === 'shortcuts' ? <>
            <h2 id="info-title">Keyboard & remote shortcuts</h2>
            <table className="shortcut-table"><tbody>
              {[
                ['↑ ↓', 'Previous / next program'],
                ['Shift + ↑ ↓, Shift-click', 'Select a block of programs'],
                ['OK / Enter', 'Pick up the selection, then drop it'],
                ['↑ ↓ while moving', 'Slide the selection earlier or later'],
                ['Back / Esc', 'Cancel a move, close a dialog'],
                ['← →', 'Previous / next day'],
                ['CH+ / CH−, PgUp / PgDn', 'Previous / next channel'],
                ['N', 'Go to what is on air now'],
                ['T', 'Today'],
                ['B', 'Show or hide break rundowns'],
                ['M', 'Move or swap…'],
                ['I', 'Insert…'],
                ['E', 'Schedule an event on a date…'],
                ['⌘Z / Ctrl+Z', 'Undo'],
                ['⇧⌘Z / Ctrl+Y', 'Redo'],
                ['⌘S / Ctrl+S', 'Save lineup'],
                ['?', 'This list'],
              ].map(([keys, action]) => <tr key={keys}><th><kbd>{keys}</kbd></th><td>{action}</td></tr>)}
            </tbody></table>
          </> : <>
            <h2 id="info-title">Tunarr Lineup</h2>
            <p className="subtle">A programming desk for your Tunarr channels: arrange and insert programs, build slot schedules, and manage commercials, filler lists and custom shows. Everything is saved through Tunarr’s own API.</p>
            <p className="subtle">{live ? `Connected through this Lineup server${connection.status === 'connected' ? ` to ${connection.host}` : ''}.` : 'Showing demo data.'}</p>
          </>}
          <div className="dialog-actions"><button className="primary" onClick={() => setInfoDialog(null)}>OK</button></div>
        </section>
      </div>}

      {slotEditor.open && slotEditor.channelId === activeChannelId && activeChannel && (slotEditor.loaded ? <ScheduleEditor
        fillerRoles={filler.roles}
        channelFillerListIds={channelFiller.channelId === activeChannelId ? channelFiller.listIds : []}
        channelLabel={`CH ${activeChannel.number} ${activeChannel.name}`}
        isNew={slotEditor.isNew}
        draft={slotEditor.draft}
        changed={slotEditor.saved ? draftKey(slotEditor.draft) !== draftKey(slotEditor.saved) : slotEditor.draft.slots.length > 0}
        catalog={catalog}
        currentChannelId={activeChannelId}
        busy={slotEditor.busy || saving}
        error={slotEditor.error}
        previewReady={!!slotEditor.preview && slotEditor.previewOf === draftKey(slotEditor.draft)}
        onChange={(draft) => setSlotEditor((current) => ({ ...current, draft, error: '' }))}
        onBrowseShow={(index) => setLibraryPicker({ purpose: 'slot-show', index })}
        onBrowseMovies={() => setLibraryPicker({ purpose: 'movies' })}
        loadSeasons={loadSeasons}
        onPreview={previewSlots}
        onSave={saveSlots}
        onDetach={slotEditor.isNew ? undefined : detachToManual}
        onRevert={() => setSlotEditor((current) => ({ ...current, draft: current.saved ? structuredClone(current.saved) : draftFromSchedule(null, current.draft.type), preview: null, previewOf: '', error: '' }))}
        onClose={() => setSlotEditor((current) => ({ ...current, open: false }))}
      /> : <div className="overlay" role="presentation">
        <section className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
          <button className="modal-close" aria-label="Close" onClick={() => setSlotEditor(closedSlotEditor)}>×</button>
          <h2 id="schedule-title">Slot schedule</h2>
          {slotEditor.error ? <div className="warning" role="alert"><b>Couldn’t load the schedule</b><span>{slotEditor.error}</span></div> : <p className="subtle">Loading the slot schedule from Tunarr…</p>}
          <div className="dialog-actions"><button onClick={() => setSlotEditor(closedSlotEditor)}>Close</button></div>
        </section>
      </div>)}

      {insertOpen && activeChannel && <InsertDialog
        live={live}
        anchorLabel={selectedItem ? (blockSize > 1 ? 'the selection' : `“${programTitle(selectedItem, programming.programs)}”`) : 'the start'}
        channels={live ? channels : []}
        currentChannelId={activeChannelId}
        date={selectedDate}
        time={inputTime(selectedInstance?.start ?? (selectedDate === inputDate(new Date(now)) ? now : dayStartMs))}
        keepOnAir={canKeepOnAir ? { checked: keepOnAir, onChange: setKeepOnAir } : undefined}
        startFor={(where, added) => { const point = insertPoint(where, added); return point.start === null ? null : { start: point.start, passes: point.passes }; }}
        onBrowse={(where) => { setInsertOpen(false); setLibraryPicker({ purpose: 'insert', where }); }}
        roles={filler.roles}
        nextStationId={nextStationId}
        stationIdTitle={nextStationId ? spotTitle(nextStationId) : undefined}
        ownStationIds={stationIds.own}
        onInsert={(items, label, where, meta) => insertAt(where, items, label, meta)}
        onClose={() => setInsertOpen(false)}
      />}

      {libraryPicker && <LibraryBrowser
        title={libraryPicker.purpose === 'insert' ? 'Insert programs' : libraryPicker.purpose === 'movies' ? 'Add movies for movie slots' : 'Choose a show for the slot'}
        mode={libraryPicker.purpose === 'insert' ? 'programs' : libraryPicker.purpose === 'movies' ? 'movies' : 'show'}
        confirmLabel={libraryPicker.purpose === 'insert' ? 'Insert' : 'Add'}
        onPick={pickFromLibrary}
        onClose={() => setLibraryPicker(null)}
      />}

      {listsOpen && <ListsManager kind={listsOpen} initialRole={listsRole} roles={filler.roles} onRoleChange={filler.setRole} onClose={() => setListsOpen(null)} onChanged={() => { filler.reload(); if (slotEditor.open || catalog) loadCatalog(); }} />}

      {eventOpen && activeChannel && <EventDialog channel={{ ...activeChannel, startTime: channelStart }} channels={channels} lineup={lineup} programs={programming.programs} date={selectedDate} generated={hasGeneratedSchedule(programming)} onClose={() => setEventOpen(false)} onPlace={placeEventEdit} />}
      {templatesOpen && <TemplatesDialog channels={channels} activeChannel={activeChannel} activeHasSchedule={hasGeneratedSchedule(programming)} catalog={catalog} fillerRoles={filler.roles} onClose={() => setTemplatesOpen(false)} onApply={applyTemplate} />}
      {setupDialog === 'smart' && <SmartCollectionsManager onClose={() => setSetupDialog(null)} onChanged={() => { if (slotEditor.open || catalog) loadCatalog(); }} />}
      {setupDialog === 'sources' && <MediaSourcesDialog onClose={() => setSetupDialog(null)} />}
      {setupDialog === 'folders' && <FillerFoldersDialog roles={filler.roles} onClose={() => setSetupDialog(null)} onChanged={() => { filler.reload(); if (slotEditor.open || catalog) loadCatalog(); }} />}
      {setupDialog === 'transcode' && <TranscodeProfilesDialog onClose={() => setSetupDialog(null)} />}
      {newChannel && <NewChannelDialog
        channels={channels}
        copyFrom={newChannel.copyFrom}
        onClose={() => setNewChannel(null)}
        onCreated={(id) => {
          setNewChannel(null);
          notify('Channel created in Tunarr');
          resetEditing();
          setSlotEditor(closedSlotEditor);
          void loadChannels(selectedDate, id);
        }}
      />}

      {settingsOpen && activeChannelId && <ChannelSettingsDialog
        fillerRoles={filler.roles}
        channelId={activeChannelId}
        onClose={() => setSettingsOpen(false)}
        onSaved={(saved, startTimeChanged) => {
          setSettingsOpen(false);
          notify('Channel settings saved to Tunarr');
          if (saved.fillerCollections) setChannelFiller({ channelId: activeChannelId, listIds: saved.fillerCollections.map((item) => item.id) });
          void tunarrApi.channels().then((list) => setChannels([...list].sort((a, b) => a.number - b.number))).catch(noteFailure);
          if (startTimeChanged && saved.id) void loadProgramming(saved.id, selectedDate, { keepSelection: true });
        }}
      />}

      {arrangeOpen && selectedItem && activeChannel && <MoveDialog
        placing={describe()}
        lineup={lineup}
        programs={programming.programs}
        block={block}
        date={selectedDate}
        previewTime={(time) => {
          const result = moveBlockToTime(lineup, block, channelStart, time);
          return result ? { start: result.start, unchanged: result.unchanged } : null;
        }}
        onMoveToTime={moveToTime}
        onMoveToPosition={moveToPosition}
        onMoveBefore={(index) => moveBefore(index)}
        onSwap={swapWith}
        onClose={() => setArrangeOpen(false)}
      />}

      {message && <div className="toast" role="status">{message}</div>}
    </main>
  );
}
