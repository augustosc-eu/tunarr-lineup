'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clockTimecode } from '../../lib/broadcast';
import { byNetwork, cellsFor, entryAt, GRID_STEP_MS, stepFocus, windowStart, type GuideChannel } from '../../lib/guideGrid';
import type { Channel } from '../../lib/lineup';
import type { ViewerCounts } from '../../lib/tunarrClient';

type Props = {
  channels: Channel[];
  activeChannelId: string;
  now: number;
  viewers: ViewerCounts;
  live: boolean;
  /** Loads the guide for every channel in [from, to). */
  loadGuide: (from: number, to: number) => Promise<GuideChannel[]>;
  /** Opens a channel in the desk at a time (and selects what airs then). */
  onOpen: (channelId: string, time: number) => void;
  onWatch?: (channelId: string) => void;
  logo: (channel: Channel) => ReactNode;
  onClose: () => void;
};

const SPAN_MS = 3 * 3_600_000;
const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const dayTime = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

/**
 * Every channel down the side and three hours across, like a cable box. The
 * arrows move between programs (and page the window at its edges), OK opens
 * the program in the desk, Back closes. Grouped by network (Tunarr's group
 * title) when asked.
 */
export function GuideGrid({ channels, activeChannelId, now, viewers, live, loadGuide, onOpen, onWatch, logo, onClose }: Props) {
  const [from, setFrom] = useState(() => windowStart(now));
  const [data, setData] = useState<Record<number, GuideChannel[]>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [grouped, setGrouped] = useState(false);
  const ordered = useMemo(() => (grouped ? byNetwork(channels).flatMap((group) => group.channels.map((channel, index) => ({ channel, network: index === 0 ? group.network : '' }))) : [...channels].sort((a, b) => a.number - b.number).map((channel) => ({ channel, network: '' }))), [channels, grouped]);
  const [focus, setFocus] = useState(() => ({ row: Math.max(0, ordered.findIndex((item) => item.channel.id === activeChannelId)), time: now }));
  const cellRefs = useRef(new Map<string, HTMLButtonElement>());
  const sectionRef = useRef<HTMLElement>(null);
  const to = from + SPAN_MS;

  // Load the window (and keep what was loaded, so paging back is instant).
  useEffect(() => {
    if (data[from] || errors[from]) return;
    let cancelled = false;
    loadGuide(from, to)
      .then((channelsData) => { if (!cancelled) setData((current) => ({ ...current, [from]: channelsData })); })
      .catch((reason) => { if (!cancelled) setErrors((current) => ({ ...current, [from]: reason instanceof Error ? reason.message : 'Couldn’t load the guide.' })); });
    return () => { cancelled = true; };
  }, [data, errors, from, loadGuide, to]);
  const error = errors[from] ?? '';

  const guide = data[from];
  const programsFor = (channelId: string) => guide?.find((item) => item.id === channelId)?.programs ?? [];
  const focusedRow = ordered[Math.min(focus.row, ordered.length - 1)];
  const focusedPrograms = focusedRow ? programsFor(focusedRow.channel.id) : [];
  const focusedIndex = entryAt(focusedPrograms, focus.time);
  const focusKey = focusedRow ? `${focusedRow.channel.id}:${focusedIndex >= 0 ? focusedPrograms[focusedIndex].start : 'empty'}` : '';

  // Keep keyboard focus on the focused program.
  useEffect(() => {
    const element = cellRefs.current.get(focusKey);
    // A row with nothing in the guide has no cell: keep the keys inside the grid anyway.
    if (!element) {
      if (!sectionRef.current?.contains(document.activeElement)) sectionRef.current?.focus({ preventScroll: true });
      document.querySelector(`[data-guide-row="${focus.row}"]`)?.scrollIntoView?.({ block: 'nearest' });
      return;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [focusKey, guide, focus.row]);

  const moveTime = (time: number) => {
    // Page the window when the focus leaves it.
    if (time < from) setFrom(windowStart(time));
    else if (time >= to) setFrom(windowStart(time) - SPAN_MS + GRID_STEP_MS);
    setFocus((current) => ({ ...current, time }));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (back(key)) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const direction = key === 'ArrowRight' ? 1 : -1;
      const next = stepFocus(focusedPrograms, Math.max(from, Math.min(focus.time, to - 1)), direction);
      moveTime(next ?? (direction > 0 ? to : from - GRID_STEP_MS));
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      setFocus((current) => ({ ...current, row: Math.max(0, Math.min(ordered.length - 1, current.row + (key === 'ArrowDown' ? 1 : -1))) }));
    } else if (key === 'PageUp' || key === 'PageDown' || key === 'ChannelUp' || key === 'ChannelDown') {
      event.preventDefault();
      const page = 8 * (key === 'PageDown' || key === 'ChannelDown' ? 1 : -1);
      setFocus((current) => ({ ...current, row: Math.max(0, Math.min(ordered.length - 1, current.row + page)) }));
    } else if (key === 'n' || key === 'N') {
      event.preventDefault();
      setFrom(windowStart(now));
      setFocus((current) => ({ ...current, time: now }));
    } else if ((key === 'l' || key === 'L') && onWatch && focusedRow) {
      event.preventDefault();
      onWatch(focusedRow.channel.id);
    }
  };

  const ticks = Array.from({ length: SPAN_MS / GRID_STEP_MS }, (_, index) => from + index * GRID_STEP_MS);
  const nowLeft = now >= from && now < to ? ((now - from) / SPAN_MS) * 100 : null;

  return (
    <div className="overlay guide-overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} tabIndex={-1} className="modal guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="guide-head">
          <h2 id="guide-title">Guide · {dayTime(from)}–{clockTimecode(to).slice(0, 5)}</h2>
          <span className="guide-controls">
            <button aria-label="Earlier" onClick={() => moveTime(from - GRID_STEP_MS * 2)}>◀ Earlier</button>
            <button onClick={() => { setFrom(windowStart(now)); setFocus((current) => ({ ...current, time: now })); }}>Now</button>
            <button aria-label="Later" onClick={() => moveTime(to + GRID_STEP_MS)}>Later ▶</button>
            <label className="check-toggle"><input type="checkbox" checked={grouped} onChange={(event) => setGrouped(event.target.checked)} /> By network</label>
          </span>
        </div>
        {!live && <p className="subtle">Demo data: the guide is projected from the sample lineup.</p>}
        {error && <div className="warning" role="alert"><b>Couldn’t load the guide</b><span>{error}</span><button onClick={() => setErrors((current) => { const next = { ...current }; delete next[from]; return next; })}>Try again</button></div>}
        <div className="guide-grid" role="grid" aria-label="Program guide" aria-busy={!guide && !error}>
          <div className="guide-row guide-times" role="row">
            <span className="guide-channel" role="columnheader">Channel</span>
            <span className="guide-track" role="columnheader">
              {ticks.map((tick) => <span key={tick} className="guide-tick" style={{ left: `${((tick - from) / SPAN_MS) * 100}%` }}>{clockTimecode(tick).slice(0, 5)}</span>)}
            </span>
          </div>
          {ordered.map(({ channel, network }, row) => {
            const programs = programsFor(channel.id);
            const cells = cellsFor(programs, from, to);
            const watching = viewers[channel.id]?.viewers ?? 0;
            return (
              <div key={channel.id} className="guide-group">
                {network && <div className="guide-network" role="row"><span role="rowheader">{network}</span></div>}
                <div className={`guide-row ${channel.id === activeChannelId ? 'current' : ''} ${row === focus.row ? 'focus-row' : ''}`} role="row" data-guide-row={row}>
                  <span className="guide-channel" role="rowheader">
                    {logo(channel)}
                    <span><b>{channel.number}</b> {channel.name}{watching > 0 && <em className="viewer-badge" aria-label={`${watching} watching`}>● {watching}</em>}</span>
                  </span>
                  <span className="guide-track">
                    {!guide && !error && row === 0 && <span className="guide-loading">Loading the guide…</span>}
                    {guide && !cells.length && <span className="guide-empty">Nothing in Tunarr’s guide for these hours.</span>}
                    {cells.map((cell) => {
                      const key = `${channel.id}:${cell.entry.start}`;
                      const focused = key === focusKey;
                      const airing = cell.entry.start <= now && now < cell.entry.stop;
                      return (
                        <button
                          key={key}
                          ref={(element) => { if (element) cellRefs.current.set(key, element); else cellRefs.current.delete(key); }}
                          role="gridcell"
                          tabIndex={focused ? 0 : -1}
                          className={`guide-cell ${airing ? 'airing' : ''} ${focused ? 'focused' : ''} ${cell.clippedStart ? 'clip-start' : ''} ${cell.clippedEnd ? 'clip-end' : ''} type-${cell.entry.type}`}
                          style={{ left: `${cell.left}%`, width: `${cell.width}%` }}
                          aria-label={`CH ${channel.number}, ${clockTimecode(cell.entry.start).slice(0, 5)} to ${clockTimecode(cell.entry.stop).slice(0, 5)}: ${cell.entry.title}${cell.entry.detail ? `, ${cell.entry.detail}` : ''}`}
                          onFocus={() => setFocus({ row, time: Math.max(cell.entry.start, from) })}
                          onClick={() => onOpen(channel.id, Math.max(cell.entry.start, from))}
                        >
                          <b>{cell.clippedStart ? '◂ ' : ''}{cell.entry.title}</b>
                          <small>{clockTimecode(cell.entry.start).slice(0, 5)}{cell.entry.detail ? ` · ${cell.entry.detail}` : ''}</small>
                        </button>
                      );
                    })}
                    {nowLeft !== null && <i className="guide-now" style={{ left: `${nowLeft}%` }} aria-hidden="true" />}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <p className="hint">← → programs · ↑ ↓ channels · OK opens it in the desk{onWatch ? ' · L watches the channel' : ''} · N now · Back closes</p>
      </section>
    </div>
  );
}
