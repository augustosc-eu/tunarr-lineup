'use client';

import { useMemo, useState } from 'react';
import { clockTimecode, durationTimecode, type Block } from '../../lib/broadcast';
import type { LineupItem, Programming } from '../../lib/lineup';
import { programDetail, programTitle } from '../../lib/programInfo';

export const MAX_CANDIDATES = 200;

type Props = {
  placing: string;
  lineup: LineupItem[];
  programs: Programming['programs'];
  block: Block;
  date: string;
  /** Where the block would start if moved toward `time` (no change made). */
  previewTime: (time: number) => { start: number; unchanged: boolean } | null;
  onMoveToTime: (time: number) => void;
  onMoveToPosition: (position: number) => void;
  onMoveBefore: (index: number) => void;
  onSwap: (index: number) => void;
  onClose: () => void;
};

const artTone = (index: number) => ['mint', 'coral', 'gold', 'blue', 'plum'][Math.max(0, index) % 5];

export function MoveDialog({ placing, lineup, programs, block, date, previewTime, onMoveToTime, onMoveToPosition, onMoveBefore, onSwap, onClose }: Props) {
  const [search, setSearch] = useState('');
  const [time, setTime] = useState('');
  const [position, setPosition] = useState('');
  const single = block.start === block.end;
  const size = block.end - block.start + 1;

  const targetTime = time ? new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`).getTime() : NaN;
  const preview = Number.isFinite(targetTime) ? previewTime(targetTime) : null;
  const positionNumber = Number(position);
  const positionValid = Number.isInteger(positionNumber) && positionNumber >= 1 && positionNumber <= lineup.length - size + 1;

  const { candidates, total } = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matches: Array<{ item: LineupItem; index: number }> = [];
    let count = 0;
    lineup.forEach((item, index) => {
      if (index >= block.start && index <= block.end) return;
      if (query && !`${programTitle(item, programs)} ${programDetail(item, programs)} #${index + 1}`.toLowerCase().includes(query)) return;
      count += 1;
      if (matches.length < MAX_CANDIDATES) matches.push({ item, index });
    });
    return { candidates: matches, total: count };
  }, [block.end, block.start, lineup, programs, search]);

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal arrange-modal" role="dialog" aria-modal="true" aria-labelledby="arrange-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">MOVE OR SWAP</p><h2 id="arrange-title">Place {placing}</h2>
        <p className="subtle">Everything here only rearranges programs already in this channel. Times assume the rest of the lineup stays as it is.</p>

        <div className="move-targets">
          <form className="move-target" onSubmit={(event) => { event.preventDefault(); if (preview && !preview.unchanged) onMoveToTime(targetTime); }}>
            <label className="field"><span>Start near time</span><input type="time" step="1" aria-label="Start near time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
            <button type="submit" className="primary" disabled={!preview || preview.unchanged}>Move</button>
            <small className="move-preview" aria-live="polite">
              {!time ? 'Pick a time on this day.' : !preview ? 'No slot near that time.' : preview.unchanged ? 'Already the closest slot to that time.' : `Will start ${clockTimecode(preview.start)} (${preview.start >= targetTime ? '+' : '−'}${durationTimecode(Math.abs(preview.start - targetTime))})`}
            </small>
          </form>
          <form className="move-target" onSubmit={(event) => { event.preventDefault(); if (positionValid) onMoveToPosition(positionNumber); }}>
            <label className="field"><span>Lineup position</span><input type="number" inputMode="numeric" min={1} max={lineup.length - size + 1} aria-label="Lineup position" placeholder={`1–${lineup.length - size + 1}`} value={position} onChange={(event) => setPosition(event.target.value)} /></label>
            <button type="submit" className="primary" disabled={!positionValid}>Move</button>
            <small className="move-preview">Currently #{block.start + 1}{size > 1 ? `–${block.end + 1}` : ''} of {lineup.length}</small>
          </form>
        </div>

        <label className="search arrange-search"><span>⌕</span><input autoFocus aria-label="Find a program" placeholder="Find a program, or #position" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <div className="candidate-list">
          {candidates.map(({ item, index }) => (
            <div className="candidate" key={`${item.id || item.type}-${index}`}>
              <span className={`mini-art ${artTone(index)}`}>{programTitle(item, programs).slice(0, 1)}</span>
              <span><b>{programTitle(item, programs)}</b><small>#{index + 1} · {programDetail(item, programs)} · {durationTimecode(item.duration)}</small></span>
              <span className="candidate-actions">
                <button onClick={() => onMoveBefore(index)}>Move before</button>
                {single && <button onClick={() => onSwap(index)}>Swap</button>}
              </span>
            </div>
          ))}
          {!candidates.length && <p className="subtle candidate-empty">No programs match.</p>}
        </div>
        {total > candidates.length && <p className="fine-print">Showing {candidates.length} of {total.toLocaleString('en')}. Type to narrow the list.</p>}
      </section>
    </div>
  );
}
