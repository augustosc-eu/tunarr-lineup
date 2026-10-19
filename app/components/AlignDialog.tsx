'use client';

import { useMemo, useState } from 'react';
import { alignToClock, durationTimecode, makeCommercialBreak, makeFlex, type ClockAlignment } from '../../lib/broadcast';
import type { FillerRoles } from '../../lib/fillerRoles';
import { roleOf } from '../../lib/fillerRoles';
import type { ListSummary } from '../../lib/library';
import { cycleDuration, type LineupItem } from '../../lib/lineup';

type Props = {
  channelLabel: string;
  lineup: LineupItem[];
  channelStart: number;
  /** True for items that count as programs (not spots, IDs or breaks). */
  isProgram: (item: LineupItem) => boolean;
  lists: ListSummary[];
  roles: FillerRoles;
  /** The lineup has already repeated, so a longer cycle moves what's on air (unless kept in place). */
  repeated: boolean;
  onApply: (result: ClockAlignment, label: string) => void;
  onClose: () => void;
};

const GRIDS = [15, 30, 60];

export function AlignDialog({ channelLabel, lineup, channelStart, isProgram, lists, roles, repeated, onApply, onClose }: Props) {
  const [grid, setGrid] = useState(30);
  const [minMinutes, setMinMinutes] = useState(5);
  const commercialLists = lists.filter((list) => roleOf(list, roles) === 'commercials' || roleOf(list, roles) === 'promos');
  const [padWith, setPadWith] = useState<string[]>(() => commercialLists.slice(0, 1).map((list) => list.id));

  const result = useMemo(() => alignToClock(
    lineup,
    channelStart,
    grid * 60_000,
    (item) => isProgram(item) && item.duration >= minMinutes * 60_000,
    (ms) => (padWith.length ? makeCommercialBreak(ms, padWith) : makeFlex(ms)),
  ), [lineup, channelStart, grid, isProgram, minMinutes, padWith]);

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal align-modal" role="dialog" aria-modal="true" aria-labelledby="align-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">{channelLabel}</p>
        <h2 id="align-title">Align programs to the clock</h2>
        <p className="subtle">Pads the lineup so programs start on the hour and half hour, the way stations run. The time goes into the break or flex before a program, or into new padding.</p>
        <div className="settings-grid">
          <label className="field"><span>Programs start every</span><select aria-label="Clock grid" value={grid} onChange={(event) => setGrid(Number(event.target.value))}>
            {GRIDS.map((minutes) => <option key={minutes} value={minutes}>{minutes === 60 ? 'hour (:00)' : minutes === 30 ? 'half hour (:00, :30)' : 'quarter hour'}</option>)}
          </select></label>
          <label className="field"><span>Only programs longer than (minutes)</span><input type="number" min={1} max={120} aria-label="Shortest program to align" value={minMinutes} onChange={(event) => setMinMinutes(Math.max(1, Math.round(Number(event.target.value)) || 1))} /></label>
        </div>
        <fieldset className="pick-lists">
          <legend>Fill the padding with</legend>
          {commercialLists.length ? commercialLists.map((list) => (
            <label key={list.id} className="check-toggle"><input type="checkbox" checked={padWith.includes(list.id)} onChange={(event) => setPadWith((current) => (event.target.checked ? [...current, list.id] : current.filter((id) => id !== list.id)))} /> {list.name}</label>
          )) : <p className="hint">No commercial or promo lists yet, so padding is flex time (the channel’s filler, or the offline screen).</p>}
          {commercialLists.length > 0 && !padWith.length && <p className="hint">Nothing ticked: padding is plain flex time.</p>}
        </fieldset>
        <div className="event-preview" role="status" aria-label="Alignment preview">
          {result ? <>
            <b>Adds {durationTimecode(result.added)} {result.pads ? `in ${result.pads} new ${result.pads === 1 ? 'pad' : 'pads'}` : 'to breaks already there'}.</b>
            <span>The lineup becomes {durationTimecode(cycleDuration(result.lineup))} (now {durationTimecode(cycleDuration(lineup))}), a whole number of {grid}-minute steps, so every pass lines up.</span>
            {repeated && <span>The lineup has already repeated, so a longer lineup moves what’s on air now. Tick “Keep what’s on air in place” in the edit list before saving to avoid that.</span>}
            <span>Daylight saving changes shift the clock by an hour twice a year; align again after them.</span>
          </> : <b>Every program already starts on the clock.</b>}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!result} onClick={() => result && onApply(result, `Aligned programs to the ${grid === 60 ? 'hour' : `${grid}-minute clock`}`)}>Align</button>
        </div>
      </section>
    </div>
  );
}
