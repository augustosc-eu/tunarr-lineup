'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AirKind } from '../../lib/airKinds';
import { clockTimecode } from '../../lib/broadcast';
import type { Channel, Instance, LineupItem, Programming } from '../../lib/lineup';
import { dateRange, dayBlocks, projectDays, weekStart, type DayRows } from '../../lib/weekLog';

type Props = {
  channel: Channel;
  lineup: LineupItem[];
  programs: Programming['programs'];
  channelStart: number;
  date: string;
  kindOf: (row: Instance) => AirKind;
  /** Shows that day in the desk with the block's first row selected. */
  onJump: (date: string, start: number, lineupIndex: number) => void;
  onExport: (days: DayRows[], label: string) => void;
  onClose: () => void;
};

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const shiftDate = (date: string, days: number) => dateRange(date, days + 1)[days];
const dayName = (date: string) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));

/**
 * The channel's week, Monday to Sunday, as blocks: the same show's episodes
 * merged, breaks folded in. Projected from the lineup, so it shows the plan
 * even past Tunarr's guide. ← → change day, ↑ ↓ move through a day, OK opens it.
 */
export function WeekView({ channel, lineup, programs, channelStart, date, kindOf, onJump, onExport, onClose }: Props) {
  const [monday, setMonday] = useState(() => weekStart(date));
  const dates = useMemo(() => dateRange(monday, 7), [monday]);
  const days = useMemo(() => projectDays(lineup, channelStart, dates), [lineup, channelStart, dates]);
  const columns = useMemo(() => days.map(({ date: day, rows }) => {
    const from = new Date(`${day}T00:00:00`).getTime();
    const to = new Date(`${shiftDate(day, 1)}T00:00:00`).getTime();
    return { date: day, blocks: dayBlocks(rows, programs, kindOf, from, to) };
  }), [days, programs, kindOf]);
  const [focus, setFocus] = useState(() => ({ day: Math.max(0, dates.indexOf(date)), block: 0 }));
  const refs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    const element = refs.current.get(`${focus.day}:${focus.block}`) ?? refs.current.get(`${focus.day}:0`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [focus, columns]);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (back(key)) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      event.preventDefault();
      const direction = key === 'ArrowRight' ? 1 : -1;
      const day = focus.day + direction;
      // Keep roughly the same time of day when changing columns.
      const at = columns[focus.day]?.blocks[focus.block]?.start ?? 0;
      const sameTime = (column: (typeof columns)[number]) => {
        const offset = at - new Date(`${columns[focus.day].date}T00:00:00`).getTime();
        const target = new Date(`${column.date}T00:00:00`).getTime() + offset;
        return Math.max(0, column.blocks.findIndex((block) => block.stop > target));
      };
      if (day < 0) { setMonday(shiftDate(monday, -7)); setFocus({ day: 6, block: 0 }); }
      else if (day > 6) { setMonday(shiftDate(monday, 7)); setFocus({ day: 0, block: 0 }); }
      else setFocus({ day, block: sameTime(columns[day]) });
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      event.preventDefault();
      const count = columns[focus.day]?.blocks.length ?? 0;
      setFocus((current) => ({ ...current, block: Math.max(0, Math.min(count - 1, current.block + (key === 'ArrowDown' ? 1 : -1))) }));
    } else if (key === 'PageUp' || key === 'PageDown') {
      event.preventDefault();
      setMonday(shiftDate(monday, key === 'PageDown' ? 7 : -7));
    }
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section className="modal week-modal" role="dialog" aria-modal="true" aria-labelledby="week-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="guide-head">
          <h2 id="week-title">CH {channel.number} {channel.name} · week of {dayName(monday)}</h2>
          <span className="guide-controls">
            <button onClick={() => setMonday(shiftDate(monday, -7))}>◀ Previous week</button>
            <button onClick={() => setMonday(weekStart(date))}>This week</button>
            <button onClick={() => setMonday(shiftDate(monday, 7))}>Next week ▶</button>
          </span>
        </div>
        <p className="subtle">Projected from the lineup{lineup.length ? '' : ' (empty)'}: the plan, including unsaved changes. Episodes of the same show are merged; breaks and spots are folded into the block before them.</p>
        <div className="week-grid" role="grid" aria-label="Week">
          {columns.map((column, day) => (
            <div key={column.date} className="week-day" role="row">
              <h3 role="columnheader">{dayName(column.date)}</h3>
              {!column.blocks.length && <p className="hint">Nothing scheduled.</p>}
              {column.blocks.map((block, index) => (
                <button
                  key={`${block.start}-${index}`}
                  ref={(element) => { const key = `${day}:${index}`; if (element) refs.current.set(key, element); else refs.current.delete(key); }}
                  role="gridcell"
                  tabIndex={focus.day === day && focus.block === index ? 0 : -1}
                  className={`week-block kind-${block.kind}`}
                  onFocus={() => setFocus({ day, block: index })}
                  onClick={() => block.lineupIndex >= 0 && onJump(column.date, block.start, block.lineupIndex)}
                >
                  <time>{clockTimecode(block.start).slice(0, 5)}</time>
                  <span><b>{block.title}</b><small>{block.count > 1 ? `${block.count} in a row` : block.detail}</small></span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button onClick={() => onExport(days, `week-${monday}`)}>Export week log…</button>
          <button onClick={() => {
            const first = `${monday.slice(0, 7)}-01`;
            const length = new Date(Number(monday.slice(0, 4)), Number(monday.slice(5, 7)), 0).getDate();
            onExport(projectDays(lineup, channelStart, dateRange(first, length)), `month-${monday.slice(0, 7)}`);
          }}>Export month log…</button>
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
