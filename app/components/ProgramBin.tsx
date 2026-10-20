'use client';

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import { airTimeLabel } from '../../lib/events';
import { spotLength } from '../../lib/fillerRoles';
import {
  childType,
  isPlayable,
  itemLabel,
  LIBRARY_SORT_LABELS,
  toContentProgram,
  TYPE_LABELS,
  type ContentProgram,
  type LibraryItem,
  type LibrarySort,
  type ListSummary,
} from '../../lib/library';
import {
  arrangedDuration,
  arrangePrograms,
  BIN_ORDER_LABELS,
  MAX_BIN_REPEAT,
  slotWindow,
  WEEKDAYS,
  type Arranged,
  type BinAfter,
  type BinOrder,
  type PlaceWhere,
  type SlotPlacement,
  type SlotPlan,
} from '../../lib/programBin';
import { libraryArtwork } from '../../lib/programInfo';
import { tunarrApi } from '../../lib/tunarrClient';
import { errorText, useLibraryListing } from '../useLibraryListing';

/** One pick: a single program, or everything in a show, season or album. */
type Pick = { key: string; item: LibraryItem; programs: ContentProgram[] };
type Spot = 'after' | 'before' | 'end' | 'time' | 'slots';
type AfterKind = BinAfter['kind'];

type Props = {
  live: boolean;
  /** “Title” of the selection on the schedule, or null when nothing is selected. */
  anchorLabel: string | null;
  emptyLineup: boolean;
  /** yyyy-mm-dd and HH:MM the "At a time" fields start at. */
  date: string;
  time: string;
  /** Filler lists tagged as Commercials, for breaks after each program. */
  commercialLists: ListSummary[];
  /** The channel's station IDs, to open those breaks with. */
  stationIds: ContentProgram[];
  /** When they'd start; `gap`: open airtime in front so they start exactly on time; `moved`: far from the spot chosen. */
  startFor: (where: PlaceWhere, added: number) => { start: number; passes: number; gap: number; moved: boolean } | null;
  /** Offered once the lineup has repeated: move the start time on save so what's on air keeps its time. */
  keepOnAir?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Inserts the arranged programs; false when nothing could be placed. */
  onPlace: (arranged: Arranged, where: PlaceWhere) => boolean;
  /** Works out recurring time slots on the lineup as it is (null when none fit). */
  planSlots: (arranged: Arranged, plan: SlotPlan) => SlotPlacement | null;
  onPlaceSlots: (arranged: Arranged, plan: SlotPlan) => boolean;
  /** Hands the arranged programs to the schedule, to place with the cursor (↑ ↓, OK). */
  onChooseSpot: (arranged: Arranged, side: 'before' | 'after') => void;
  /** A drag toward the schedule began: what it would place (folders load as they're dragged). */
  onDragPrograms: (resolve: Promise<Arranged>, done: () => void) => void;
  onDragEnd: () => void;
  onClose: () => void;
};

const MINUTE = 60_000;
const clockLabel = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const WIDE_TYPES = new Set(['episode', 'other_video', 'music_video', 'track']);

/** Poster or still through the companion, or the title's initial when there is none. */
function BinArt({ item, live, wide }: { item: LibraryItem; live: boolean; wide: boolean }) {
  const src = libraryArtwork(item.uuid, live, wide ? 'thumbnail' : 'poster');
  const [failed, setFailed] = useState('');
  return (
    <span className={`bin-art ${src && failed !== src ? 'has-image' : ''}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && failed !== src ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(src)} /> : (item.title || '?').slice(0, 1)}
    </span>
  );
}

/** The slots asked for, or null until there's a date, a time, a weekday and (filling until) an end. */
function slotPlan(day: string, time: string, weekdays: number[], fillKind: SlotPlan['fill']['kind'], count: number, until: string): SlotPlan | null {
  if (!Number.isFinite(new Date(`${day}T${time}:00`).getTime()) || !weekdays.length || (fillKind === 'until' && !until)) return null;
  return { day, time, weekdays, fill: fillKind === 'count' ? { kind: 'count', count } : { kind: 'until', until } };
}

/** "20:00" an hour later, for the end of a time window. */
const hourAfter = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? `${String((hours + 1) % 24).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` : '';
};

export function ProgramBin({ live, anchorLabel, emptyLineup, date, time: initialTime, commercialLists, stationIds, startFor, keepOnAir, onPlace, planSlots, onPlaceSlots, onChooseSpot, onDragPrograms, onDragEnd, onClose }: Props) {
  const listing = useLibraryListing();
  const { usableSources, sources, sourceId, libraries, libraryId, library, source, path, folder, text, query, shown, results, totalHits, loading, error, setError, complete, order } = listing;
  const [picks, setPicks] = useState<Pick[]>([]);
  const [adding, setAdding] = useState('');
  const [binOrder, setBinOrder] = useState<BinOrder>('picked');
  const [repeat, setRepeat] = useState(1);
  const [afterKind, setAfterKind] = useState<AfterKind>('none');
  const [afterLength, setAfterLength] = useState(2 * MINUTE);
  const [withId, setWithId] = useState(true);
  const [spot, setSpot] = useState<Spot>(anchorLabel ? 'after' : 'end');
  const [day, setDay] = useState(date);
  const [time, setTime] = useState(initialTime);
  const [exact, setExact] = useState(true);
  const [weekdays, setWeekdays] = useState<number[]>(WEEKDAYS.map(([day]) => day));
  const [fillKind, setFillKind] = useState<SlotPlan['fill']['kind']>('count');
  const [perSlot, setPerSlot] = useState(1);
  const [until, setUntil] = useState(hourAfter(initialTime));
  const gridRef = useRef<HTMLDivElement>(null);
  // The first card takes focus when the bin opens and when a show or season opens, so a remote starts there.
  const focusedPath = useRef<string | null>(null);
  const pathKey = path.map((item) => item.uuid).join('/');
  useEffect(() => {
    if (!shown.length || focusedPath.current === pathKey) return;
    focusedPath.current = pathKey;
    gridRef.current?.querySelector<HTMLButtonElement>('.bin-card-main')?.focus({ preventScroll: true });
  }, [pathKey, shown.length]);

  const pickedKeys = useMemo(() => new Map(picks.map((pick, at) => [pick.key, at])), [picks]);
  const wide = shown.filter((item) => WIDE_TYPES.has(item.type)).length > shown.length / 2;
  const listKey = commercialLists.map((list) => list.id).join(',');
  const listIds = useMemo(() => (listKey ? listKey.split(',') : []), [listKey]);
  const after: BinAfter = useMemo(() => (afterKind === 'flex' ? { kind: 'flex', duration: afterLength }
    : afterKind === 'break' && listIds.length ? { kind: 'break', duration: afterLength, fillerListIds: listIds, stationIds: withId ? stationIds : [] }
    : { kind: 'none' }), [afterKind, afterLength, listIds, stationIds, withId]);
  const arrange = (programs: ContentProgram[]) => arrangePrograms(programs, { order: binOrder, repeat, after });
  // Picks may overlap (a season and one of its episodes): each program airs once per pass.
  const pickedPrograms = useMemo(() => {
    const seen = new Set<string>();
    return picks.flatMap((pick) => pick.programs).filter((program) => !seen.has(program.id) && !!seen.add(program.id));
  }, [picks]);
  // Arranged once, so what's previewed (a shuffle, the slots) is what gets placed.
  const arranged = useMemo(() => arrangePrograms(pickedPrograms, { order: binOrder, repeat, after }), [pickedPrograms, binOrder, repeat, after]);
  const length = arrangedDuration(arranged);

  const at = new Date(`${day}T${time}:00`).getTime();
  const where: PlaceWhere | null = spot === 'time' ? (Number.isFinite(at) ? { at, snap: exact ? 'exact' : 'after' } : null) : spot === 'slots' ? null : spot;
  const point = where && arranged.items.length ? startFor(where, length) : null;
  const plan = slotPlan(day, time, weekdays, fillKind, perSlot, until);
  const slots = useMemo(() => {
    const asked = slotPlan(day, time, weekdays, fillKind, perSlot, until);
    return spot === 'slots' && asked && arranged.items.length && !emptyLineup ? planSlots(arranged, asked) : null;
  }, [arranged, day, emptyLineup, fillKind, perSlot, planSlots, spot, time, until, weekdays]);

  const programsOf = async (item: LibraryItem) => {
    if (isPlayable(item)) return [toContentProgram(item)];
    const programs = await tunarrApi.descendants(item.uuid);
    return programs.filter((program) => program.duration > 0);
  };
  const togglePick = async (item: LibraryItem) => {
    if (pickedKeys.has(item.uuid)) {
      setPicks((current) => current.filter((pick) => pick.key !== item.uuid));
      return;
    }
    setAdding(item.uuid);
    try {
      const programs = await programsOf(item);
      if (!programs.length) { setError(`Nothing in “${itemLabel(item)}” can be played.`); return; }
      setPicks((current) => (current.some((pick) => pick.key === item.uuid) ? current : [...current, { key: item.uuid, item, programs }]));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setAdding('');
    }
  };
  const pickAllHere = async () => {
    if (folder) await togglePick(folder);
    else setPicks((current) => [...current, ...shown.filter((item) => isPlayable(item) && !pickedKeys.has(item.uuid)).map((item) => ({ key: item.uuid, item, programs: [toContentProgram(item)] }))]);
  };

  const place = () => {
    if (!pickedPrograms.length) return;
    if (spot === 'slots' ? plan && slots && onPlaceSlots(arranged, plan) : where && onPlace(arranged, where)) setPicks([]);
  };
  const chooseSpot = () => {
    if (!pickedPrograms.length || emptyLineup) return;
    onChooseSpot(arranged, spot === 'before' ? 'before' : 'after');
    setPicks([]);
  };

  // Dragging a picked card takes every pick along, the way dragging a selected row moves the block.
  const dragStart = (event: DragEvent, item?: LibraryItem) => {
    const all = !item || pickedKeys.has(item.uuid);
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData('text/plain', all ? `${pickedPrograms.length} programs` : itemLabel(item));
    const resolve = all ? Promise.resolve(arranged) : programsOf(item).then(arrange);
    onDragPrograms(resolve, () => { if (all) setPicks([]); });
  };

  // Arrow keys move between cards (the grid wraps like a page of text); Space picks.
  const gridKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    const cards = [...(gridRef.current?.querySelectorAll<HTMLButtonElement>('.bin-card-main') ?? [])];
    const current = cards.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const top = cards[0]?.offsetTop;
    const columns = Math.max(1, cards.findIndex((card) => card.offsetTop !== top) === -1 ? cards.length : cards.findIndex((card) => card.offsetTop !== top));
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (step !== undefined) {
      const next = cards[current + step];
      if (!next) return;
      event.preventDefault();
      next.focus();
      next.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === ' ') {
      event.preventDefault();
      const item = shown[current];
      if (item && (isPlayable(item) || childType(item.type))) void togglePick(item);
    }
  };
  const panelKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (!['Escape', 'GoBack', 'BrowserBack'].includes(event.key)) return;
    event.preventDefault();
    if (path.length) listing.goUp(path.length - 1);
    else onClose();
  };

  const spots: Array<[Spot, string, boolean]> = [
    ['after', anchorLabel ? `After ${anchorLabel}` : 'After the selection', !!anchorLabel],
    ['before', anchorLabel ? `Before ${anchorLabel}` : 'Before the selection', !!anchorLabel],
    ['end', 'At the end', true],
    ['time', 'At a time…', !emptyLineup],
    ['slots', 'In time slots…', !emptyLineup],
  ];
  const keepHint = keepOnAir && !keepOnAir.checked ? ' Tick “Keep what’s on air in place” to keep that spot where it is.' : '';
  const toggleWeekday = (weekday: number) => setWeekdays((current) => (current.includes(weekday) ? current.filter((entry) => entry !== weekday) : [...current, weekday]));
  const firstSlot = slots?.slots[0];
  const lastSlot = slots?.slots[slots.slots.length - 1];

  return (
    <aside className="program-bin" aria-label="Program bin" onKeyDown={panelKeys}>
      <div className="bin-head">
        <button className="modal-close bin-close" aria-label="Close the program bin" onClick={onClose}>×</button>
        <p className="eyebrow">PROGRAM BIN</p>
        <small>Pick programs, set how they air, then place them, or drag any card onto the schedule.</small>
      </div>
      <div className="library-pickers bin-pickers">
        <label className="field"><span>Media source</span>
          <select value={sourceId} onChange={(event) => listing.chooseSource(event.target.value)} disabled={!sources}>
            {usableSources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Library</span>
          <select value={libraryId} onChange={(event) => listing.chooseLibrary(event.target.value)} disabled={!libraries.length}>
            {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <form className="library-search" onSubmit={(event) => { event.preventDefault(); listing.search(); }}>
          <label className="search"><span>⌕</span><input aria-label="Search the library" placeholder={complete ? 'Find by title or number' : 'Search this library'} value={text} onChange={(event) => listing.type(event.target.value)} /></label>
          <button type="submit">Search</button>
        </form>
      </div>

      <nav className="library-path" aria-label="Location">
        <button className="quiet" onClick={() => listing.goUp(0)} disabled={!path.length}>{library?.name ?? source?.name ?? 'Library'}{query && !path.length ? ` · “${query}”` : ''}</button>
        {path.map((item, index) => <span key={item.uuid}> › <button className="quiet" onClick={() => listing.goUp(index + 1)} disabled={index === path.length - 1}>{itemLabel(item)}</button></span>)}
        <small>{complete && query ? `${shown.length.toLocaleString('en')} of ${results.length.toLocaleString('en')}` : `${totalHits.toLocaleString('en')} ${totalHits === 1 ? 'item' : 'items'}`}</small>
        {complete && <select aria-label="Order" value={order} onChange={(event) => listing.setSort(event.target.value as LibrarySort)}>
          {(Object.keys(LIBRARY_SORT_LABELS) as LibrarySort[]).map((value) => <option key={value} value={value}>{LIBRARY_SORT_LABELS[value]}</option>)}
        </select>}
        {(folder || shown.some(isPlayable)) && <button disabled={!!adding} onClick={() => void pickAllHere()}>{folder ? (pickedKeys.has(folder.uuid) ? `Unpick all of ${itemLabel(folder)}` : `Pick all of ${itemLabel(folder)}`) : 'Pick all shown'}</button>}
      </nav>

      <div className="bin-body">
      <div ref={gridRef} className={`bin-grid ${wide ? 'wide' : ''}`} aria-busy={loading} onKeyDown={gridKeys}>
        {error && <div className="warning" role="alert"><b>Library unavailable</b><span>{error}</span></div>}
        {!loading && !error && !shown.length && <p className="subtle candidate-empty">{query ? `Nothing matches “${query}”.` : 'Nothing here.'}</p>}
        {shown.map((item) => {
          const folderType = childType(item.type);
          const playable = isPlayable(item);
          const pickedAt = pickedKeys.get(item.uuid);
          const label = itemLabel(item);
          const meta = [TYPE_LABELS[item.type] ?? item.type, item.duration ? durationTimecode(item.duration) : '', item.childCount ? `${item.childCount} ${folderType ?? 'item'}s` : ''].filter(Boolean).join(' · ');
          return (
            <div key={item.uuid} className={`bin-card ${pickedAt !== undefined ? 'picked' : ''}`} draggable={playable || !!folderType} onDragStart={(event) => dragStart(event, item)} onDragEnd={onDragEnd}>
              <button className="bin-card-main" aria-label={`${folderType ? 'Open' : pickedAt !== undefined ? 'Unpick' : 'Pick'} ${label}`} aria-pressed={folderType ? undefined : pickedAt !== undefined}
                onClick={() => (folderType ? listing.open(item) : playable ? void togglePick(item) : undefined)}>
                <BinArt item={item} live={live} wide={wide} />
                {pickedAt !== undefined && <em className="bin-check" aria-hidden="true">{pickedAt + 1}</em>}
                <b>{label}</b>
                <small>{meta}</small>
              </button>
              {folderType && <button className="bin-add" disabled={adding === item.uuid} aria-label={`${pickedAt !== undefined ? 'Unpick' : 'Pick'} all of ${label}`} onClick={() => void togglePick(item)}>{adding === item.uuid ? '…' : pickedAt !== undefined ? '✓ All' : '+ All'}</button>}
            </div>
          );
        })}
        {listing.canLoadMore && <button className="wide bin-more" disabled={loading} onClick={listing.loadMore}>{loading ? 'Loading…' : 'Load more'}</button>}
      </div>

      <section className="bin-tray" aria-label="Picked programs">
        <div className="bin-tray-head">
          <span draggable={pickedPrograms.length > 0} onDragStart={(event) => dragStart(event)} onDragEnd={onDragEnd} className={`bin-grip ${pickedPrograms.length ? '' : 'empty'}`} title="Drag onto the schedule">
            {pickedPrograms.length ? <><span aria-hidden="true">⠿ </span><b>{pickedPrograms.length.toLocaleString('en')}</b> picked · {durationTimecode(length)}{repeat > 1 ? ` with ${repeat} passes` : ''}</> : 'Pick programs above: OK on a program, + All (or Space) on a show.'}
          </span>
          {picks.length > 0 && <button className="quiet" onClick={() => setPicks([])}>Clear</button>}
        </div>
        {picks.length > 0 && <ol className="basket-list bin-picks">
          {picks.map((pick) => <li key={pick.key}><span>{itemLabel(pick.item)}{pick.programs.length > 1 ? ` · ${pick.programs.length} programs` : ''}</span><small>{durationTimecode(pick.programs.reduce((sum, program) => sum + program.duration, 0))}</small><button className="quiet" aria-label={`Remove ${itemLabel(pick.item)}`} onClick={() => setPicks((current) => current.filter((entry) => entry.key !== pick.key))}>×</button></li>)}
        </ol>}

        <div className="bin-options">
          <label className="field"><span>Order</span>
            <select aria-label="Play order" value={binOrder} onChange={(event) => setBinOrder(event.target.value as BinOrder)}>
              {(Object.keys(BIN_ORDER_LABELS) as BinOrder[]).map((value) => <option key={value} value={value}>{BIN_ORDER_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="field"><span>Passes</span>
            <input type="number" aria-label="Passes" min={1} max={MAX_BIN_REPEAT} step={1} value={repeat} onChange={(event) => setRepeat(Math.min(MAX_BIN_REPEAT, Math.max(1, Math.round(Number(event.target.value)) || 1)))} />
          </label>
          <label className="field"><span>After each program</span>
            <select aria-label="After each program" value={afterKind} onChange={(event) => setAfterKind(event.target.value as AfterKind)}>
              <option value="none">Nothing</option>
              <option value="break" disabled={!listIds.length}>Commercial break{listIds.length ? '' : ' (no Commercials lists)'}</option>
              <option value="flex">Flex time</option>
            </select>
          </label>
          {afterKind !== 'none' && <label className="field"><span>Length (minutes)</span>
            <input type="number" aria-label="Length after each program in minutes" min={0.25} max={60} step={0.25} value={afterLength / MINUTE} onChange={(event) => setAfterLength(Math.max(0, Number(event.target.value)) * MINUTE)} />
          </label>}
        </div>
        {afterKind === 'break' && listIds.length > 0 && <p className="subtle bin-note">Filled from {commercialLists.map((list) => list.name).join(', ')}.
          {stationIds.length > 0 && <label className="keep-on-air"><input type="checkbox" checked={withId} onChange={(event) => setWithId(event.target.checked)} /> Open each break with a station ID <small>{stationIds.length} {stationIds.length === 1 ? 'ID rotates' : 'IDs rotate'} ({stationIds.map((id) => spotLength(id.duration)).join(', ')}); the ID comes out of the break’s length.</small></label>}
        </p>}

        <div className="segmented bin-where" role="radiogroup" aria-label="Where to place them">
          {spots.map(([value, label, enabled]) => <button key={value} title={label} role="radio" aria-checked={spot === value} className={spot === value ? 'primary' : ''} disabled={!enabled} onClick={() => setSpot(value)}>{label}</button>)}
        </div>
        {(spot === 'time' || spot === 'slots') && <div className="bin-options">
          <label className="field"><span>{spot === 'slots' ? 'First day' : 'Date'}</span><input type="date" aria-label={spot === 'slots' ? 'First slot on date' : 'Place on date'} value={day} onChange={(event) => setDay(event.target.value)} /></label>
          <label className="field"><span>Time</span><input type="time" aria-label={spot === 'slots' ? 'Slot time' : 'Place at time'} value={time} onChange={(event) => setTime(event.target.value)} /></label>
          {spot === 'time' && <label className="field bin-wide"><span>Start</span>
            <select aria-label="Start" value={exact ? 'exact' : 'after'} onChange={(event) => setExact(event.target.value === 'exact')}>
              <option value="exact">Exactly at this time (open airtime fills the gap)</option>
              <option value="after">When the program airing then ends</option>
            </select>
          </label>}
        </div>}
        {spot === 'slots' && <>
          <div className="segmented bin-days" role="group" aria-label="Slot days">
            {WEEKDAYS.map(([weekday, label]) => <button key={weekday} aria-pressed={weekdays.includes(weekday)} className={weekdays.includes(weekday) ? 'primary' : ''} onClick={() => toggleWeekday(weekday)}>{label}</button>)}
          </div>
          <div className="bin-options">
            <label className="field"><span>Each slot</span>
              <select aria-label="Each slot" value={fillKind} onChange={(event) => setFillKind(event.target.value as SlotPlan['fill']['kind'])}>
                <option value="count">A set number</option>
                <option value="until">Fill until…</option>
              </select>
            </label>
            {fillKind === 'count'
              ? <label className="field"><span>Programs per slot</span><input type="number" aria-label="Programs per slot" min={1} max={MAX_BIN_REPEAT} step={1} value={perSlot} onChange={(event) => setPerSlot(Math.min(MAX_BIN_REPEAT, Math.max(1, Math.round(Number(event.target.value)) || 1)))} /></label>
              : <label className="field"><span>Until</span><input type="time" aria-label="Slot ends at" value={until} onChange={(event) => setUntil(event.target.value)} /></label>}
          </div>
        </>}
        <p className="insert-when" role="status" aria-label="Placement">
          {!pickedPrograms.length ? 'Nothing picked yet. You can also drag any card onto a row of the schedule.'
            : emptyLineup ? 'This lineup is empty, so these become its first programs.'
            : spot === 'slots' ? (!plan ? 'Choose a first day, a time and at least one day of the week.'
              : !slots || !firstSlot || !lastSlot ? `No slot can start on time there.${keepHint}`
              : <><b>{slots.placed.toLocaleString('en')} {slots.placed === 1 ? 'program' : 'programs'} in {slots.slots.length.toLocaleString('en')} {slots.slots.length === 1 ? 'slot' : 'slots'}</b>, {airTimeLabel(firstSlot.at)}{slots.slots.length > 1 ? ` to ${airTimeLabel(lastSlot.at)}` : ''}{fillKind === 'until' ? ` (until ${until}, ${durationTimecode(slotWindow(time, until))} each)` : ''}. What airs at those times moves later{slots.gaps ? `, and ${durationTimecode(slots.gaps)} of open airtime fills up to the slots so each starts on time` : ''}.
                {slots.stopped && <> {slots.left.toLocaleString('en')} more {slots.left === 1 ? 'doesn’t' : 'don’t'} fit: {slots.stopped.reason === 'repeats' ? `the lineup repeats before ${airTimeLabel(slots.stopped.at)}, and a slot in its next pass would move the ones before it.` : `the lineup has repeated, so the next slot would move the ones before it.${keepHint}`}</>}</>)
            : !point ? 'Choose a date and time.'
            : <><b>Starts {airTimeLabel(point.start)}</b>, ends {clockLabel(point.start + length)}.{point.gap ? ` ${durationTimecode(point.gap)} of open airtime fills up to it, and the program airing then moves after these.` : ''} {point.passes > 0 ? (keepOnAir?.checked ? 'What’s on air keeps its time; programs around these still move.' : 'The lineup has repeated, so programs around these move too.') : 'Everything after them airs later.'}</>}
        </p>
        {spot !== 'slots' && point?.moved && pickedPrograms.length > 0 && <div className="warning bin-moved" role="alert"><b>Not where you chose</b><span>Adding {durationTimecode(length)} lengthens every pass of the lineup that has already aired, so the spot you chose moves to {airTimeLabel(point.start)}.{spot === 'time' ? ' At the time you chose, something else in the lineup airs instead, possibly part-way through these programs.' : ''}{keepHint || (keepOnAir ? ' The lineup repeats between now and then, so that spot can’t stay put.' : '')}</span></div>}
        {keepOnAir && pickedPrograms.length > 0 && <label className="keep-on-air"><input type="checkbox" checked={keepOnAir.checked} onChange={(event) => keepOnAir.onChange(event.target.checked)} /> Keep what’s on air in place</label>}
        <div className="dialog-actions">
          <button disabled={!pickedPrograms.length || emptyLineup} onClick={chooseSpot}>Choose spot on schedule…</button>
          {spot === 'slots'
            ? <button className="primary" disabled={!slots} onClick={place}>Place in {slots ? `${slots.slots.length.toLocaleString('en')} ${slots.slots.length === 1 ? 'slot' : 'slots'}` : 'time slots'}</button>
            : <button className="primary" disabled={!pickedPrograms.length || !where} onClick={place}>Place {pickedPrograms.length ? pickedPrograms.length.toLocaleString('en') : ''} on schedule</button>}
        </div>
      </section>
      </div>
    </aside>
  );
}
