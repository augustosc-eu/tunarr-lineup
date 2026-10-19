'use client';

import { useEffect, useMemo, useRef } from 'react';
import { cellsFor, entryAt, type GuideChannel, type GuideEntry } from '../../lib/guideGrid';
import type { Channel } from '../../lib/lineup';
import { CLASSIC_SPAN_MS, progress } from '../../lib/tvRemote';

export type CableFocus = { row: number; time: number; page: number; top: number };

type Props = {
  /** Channels in dial order. */
  dial: Channel[];
  currentId: string;
  now: number;
  /** The first half hour of page 0. */
  base: number;
  focus: CableFocus;
  rows: number;
  /** The loaded guide for the page's three-hour chunk, if it's in. */
  guide: GuideChannel[] | undefined;
  error: string;
  onRetry: () => void;
  onPick: (row: number, time: number) => void;
  onTune: (channelId: string) => void;
};

export const clock = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const day = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' }).format(new Date(ms));

/**
 * The on-screen guide of a cable box from around 2002: the picture keeps
 * playing in a window at the top right, the focused program's details sit
 * beside it, and below, a few channels at a time, ninety minutes across in
 * half-hour columns. It only looks ahead, like the boxes did. Keys are handled
 * by the player (WatchDialog), which owns the focus.
 */
export function CableGuide({ dial, currentId, now, base, focus, rows, guide, error, onRetry, onPick, onTune }: Props) {
  const from = base + focus.page * CLASSIC_SPAN_MS;
  const to = from + CLASSIC_SPAN_MS;
  const programsFor = (channelId: string): GuideEntry[] => guide?.find((item) => item.id === channelId)?.programs ?? [];
  const focusedChannel = dial[focus.row];
  const focusedPrograms = focusedChannel ? programsFor(focusedChannel.id) : [];
  const focusedEntry = focusedPrograms[entryAt(focusedPrograms, focus.time)] ?? null;
  const columns = [0, 1, 2].map((index) => from + index * 30 * 60_000);
  const shown = useMemo(() => dial.slice(focus.top, focus.top + rows).map((channel, index) => ({ channel, row: focus.top + index })), [dial, focus.top, rows]);
  const focusedCell = useRef<HTMLButtonElement>(null);
  // Keep the browser's focus on the highlighted program, so screen readers follow it.
  useEffect(() => { focusedCell.current?.focus({ preventScroll: true }); }, [focus.row, focus.time, focus.page, guide]);

  return (
    <div className="cable-guide">
      <div className="cable-top">
        <div className="cable-info" aria-live="polite">
          {focusedChannel && <p className="cable-info-channel">{focusedChannel.number} {focusedChannel.name}{focusedChannel.groupTitle ? <span> · {focusedChannel.groupTitle}</span> : null}</p>}
          {focusedEntry ? <>
            <h3>{focusedEntry.title}</h3>
            <p>{clock(focusedEntry.start)} – {clock(focusedEntry.stop)}{focusedEntry.detail ? ` · ${focusedEntry.detail}` : ''}</p>
            {focusedEntry.start <= now && now < focusedEntry.stop
              ? <p className="cable-airing"><span className="cable-progress" aria-hidden="true"><i style={{ width: `${progress(focusedEntry, now) * 100}%` }} /></span> On now · OK tunes in</p>
              : <p className="cable-airing">Starts {day(focusedEntry.start)} {clock(focusedEntry.start)} · OK tunes to the channel</p>}
          </> : <h3>{error ? 'Guide unavailable' : guide ? 'No listing' : 'Loading listings…'}</h3>}
        </div>
        <div className="cable-pip-slot" aria-hidden="true" />
      </div>
      {error && <div className="cable-error" role="alert">{error} <button type="button" onClick={onRetry}>Try again</button></div>}
      <div className="cable-grid" role="grid" aria-label="Cable guide" aria-busy={!guide && !error}>
        <div className="cable-row cable-head" role="row">
          <span className="cable-channel" role="columnheader">{day(from)}</span>
          {columns.map((time) => <span key={time} className="cable-time" role="columnheader">{clock(time)}</span>)}
          {focus.page > 0 && <span className="cable-more left" aria-hidden="true">◀</span>}
          <span className="cable-more right" aria-hidden="true">▶</span>
        </div>
        {shown.map(({ channel, row }) => {
          const cells = cellsFor(programsFor(channel.id), from, to);
          return (
            <div key={channel.id} className={`cable-row ${channel.id === currentId ? 'tuned' : ''} ${row === focus.row ? 'focus-row' : ''}`} role="row">
              <span className="cable-channel" role="rowheader"><b>{channel.number}</b> <span>{channel.name}</span></span>
              <span className="cable-track">
                {guide && !cells.length && <span className="cable-cell empty">To be announced</span>}
                {cells.map((cell) => {
                  const focused = row === focus.row && cell.entry === focusedEntry;
                  return (
                    <button
                      key={cell.entry.start}
                      ref={focused ? focusedCell : undefined}
                      type="button"
                      role="gridcell"
                      tabIndex={focused ? 0 : -1}
                      className={`cable-cell ${focused ? 'focused' : ''} type-${cell.entry.type}`}
                      style={{ left: `${cell.left}%`, width: `${cell.width}%` }}
                      aria-label={`${channel.number} ${channel.name}, ${clock(cell.entry.start)} to ${clock(cell.entry.stop)}: ${cell.entry.title}`}
                      onClick={() => (focused ? onTune(channel.id) : onPick(row, Math.max(cell.entry.start, from)))}
                    >
                      {cell.clippedStart && <span aria-hidden="true">◂ </span>}{cell.entry.title}{cell.clippedEnd && <span aria-hidden="true"> ▸</span>}
                    </button>
                  );
                })}
                {now >= from && now < to && <i className="cable-now" style={{ left: `${((now - from) / CLASSIC_SPAN_MS) * 100}%` }} aria-hidden="true" />}
              </span>
            </div>
          );
        })}
      </div>
      <p className="cable-legend"><span>▲▼ Channels</span><span>◀▶ Time</span><span>PG± Page</span><span>OK Tune</span><span>Back Exit</span></p>
    </div>
  );
}
