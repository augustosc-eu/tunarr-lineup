'use client';

import { useMemo, useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import { airTimeLabel as when, buildMarathon, placeEvent, repeatLabel, type EventMode, type EventPlacement } from '../../lib/events';
import { roleOf, type FillerRoles } from '../../lib/fillerRoles';
import { lineupEntry, type ContentProgram, type ListSummary } from '../../lib/library';
import type { Channel, LineupItem, Programming } from '../../lib/lineup';
import { programTitle } from '../../lib/programInfo';
import { LibraryBrowser } from './LibraryBrowser';

type Props = {
  channel: Channel;
  lineup: LineupItem[];
  programs: Programming['programs'];
  date: string;
  lists: ListSummary[];
  roles: FillerRoles;
  /** The next station ID in rotation, to open each break with. */
  stationId?: { id: string; duration: number };
  generated: boolean;
  onClose: () => void;
  onPlace: (placement: EventPlacement, label: string, meta: Record<string, ContentProgram>, date: string) => void;
};

const inputDate = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * A marathon: a season (or any run of programs) back to back on a date, with
 * a commercial break between episodes. It goes into the lineup as an event.
 */
export function MarathonDialog({ channel, lineup, programs, date, lists, roles, stationId, generated, onClose, onPlace }: Props) {
  const [day, setDay] = useState(date);
  const [time, setTime] = useState('10:00');
  const [picked, setPicked] = useState<ContentProgram[]>([]);
  const [breakMinutes, setBreakMinutes] = useState(3);
  const commercialLists = lists.filter((list) => roleOf(list, roles) === 'commercials' || roleOf(list, roles) === 'promos');
  const [listIds, setListIds] = useState<string[]>(() => commercialLists.map((list) => list.id));
  const [withId, setWithId] = useState(!!stationId);
  const [mode, setMode] = useState<EventMode>('replace');
  const [name, setName] = useState('');
  const [browsing, setBrowsing] = useState(false);

  const at = new Date(`${day}T${time}:00`).getTime();
  const items = useMemo(() => buildMarathon(picked.map((program) => lineupEntry(program).item), {
    breakMs: breakMinutes * 60_000, fillerListIds: listIds, stationId: withId ? stationId : undefined,
  }), [picked, breakMinutes, listIds, withId, stationId]);
  const placement = Number.isFinite(at) && picked.length ? placeEvent(lineup, channel.startTime, at, items, mode, 'after') : null;
  const show = picked[0] ? String(((picked[0].program as { show?: { title?: string }; title?: string }).show?.title) ?? (picked[0].program as { title?: string }).title ?? 'Marathon') : '';
  const title = name.trim() || (picked.length ? `${show} marathon` : 'Marathon');
  const removed = placement?.removed.map((item) => programTitle(item, programs)) ?? [];

  return (
    <div className="overlay" role="presentation" onKeyDown={(event) => {
      if (browsing && (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack')) { event.stopPropagation(); setBrowsing(false); }
    }}>
      <section className="modal event-modal marathon-modal" role="dialog" aria-modal="true" aria-labelledby="marathon-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="marathon-title">Marathon</h2>
        <p className="subtle">Open a show or a season in the library and choose Add all, then pick when it starts. Episodes air back to back with a break between each.</p>
        <div className="list-toolbar">
          <span>{picked.length ? `${picked.length} ${picked.length === 1 ? 'program' : 'programs'} · ${durationTimecode(picked.reduce((sum, program) => sum + program.duration, 0))} of programs` : 'Nothing picked yet.'}</span>
          <button onClick={() => setBrowsing(true)}>{picked.length ? 'Change programs…' : 'Choose a season…'}</button>
        </div>
        <div className="settings-grid">
          <label className="field"><span>Date</span><input type="date" aria-label="Marathon date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
          <label className="field"><span>Starts at</span><input type="time" aria-label="Marathon time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <label className="field"><span>Name (for the edit list)</span><input aria-label="Marathon name" value={name} placeholder={picked.length ? `${show} marathon` : 'Saturday marathon'} onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>Break between episodes (minutes, 0 for none)</span><input type="number" min={0} max={20} aria-label="Break minutes" value={breakMinutes} onChange={(event) => setBreakMinutes(Math.max(0, Math.min(20, Math.round(Number(event.target.value)) || 0)))} /></label>
          <label className="field"><span>Then</span><select aria-label="Marathon mode" value={mode} onChange={(event) => setMode(event.target.value as EventMode)}>
            <option value="replace">Replace what was on; later programs keep their times</option>
            <option value="push">Push everything after it later</option>
          </select></label>
        </div>
        {breakMinutes > 0 && <fieldset className="pick-lists">
          <legend>Breaks are filled from</legend>
          {commercialLists.length ? commercialLists.map((list) => <label key={list.id} className="check-toggle"><input type="checkbox" checked={listIds.includes(list.id)} onChange={(event) => setListIds((current) => (event.target.checked ? [...current, list.id] : current.filter((id) => id !== list.id)))} /> {list.name}</label>)
            : <p className="hint">No commercial lists yet, so breaks are flex time.</p>}
          {stationId && <label className="check-toggle"><input type="checkbox" checked={withId} onChange={(event) => setWithId(event.target.checked)} /> Open each break with a station ID</label>}
        </fieldset>}
        {placement && <div className="event-preview" role="status" aria-label="Marathon placement">
          <b>{title}: {when(placement.start)} – {when(placement.end)}</b>
          {placement.drift !== 0 && <span>Starts {durationTimecode(Math.abs(placement.drift))} after {time}, when the program on air ends.</span>}
          {mode === 'replace' && <span>Takes off: {removed.length ? `${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ` and ${removed.length - 6} more` : ''}` : 'nothing'}{placement.pad ? `; then ${durationTimecode(placement.pad)} of flex so everything after stays on time` : ''}.</span>}
          {mode === 'replace' && placement.overrun > 0 && <span>It runs {durationTimecode(placement.overrun)} past the end of the lineup, so the lineup gets that much longer.</span>}
          <span>This lineup repeats {repeatLabel(placement.cycle)}, so the marathon repeats with it. To air it once, use Edit → Schedule Event with “Air once”.</span>
          {generated && <span>Saving the slot schedule regenerates the lineup and removes the marathon.</span>}
        </div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <span className="spacer" />
          <button className="primary" disabled={!placement} onClick={() => placement && onPlace(placement, title, Object.fromEntries(picked.map((program) => lineupEntry(program).meta)), inputDate(placement.start))}>Place marathon</button>
        </div>
      </section>
      {browsing && <LibraryBrowser title="Programs for the marathon" mode="programs" confirmLabel="Use" onClose={() => setBrowsing(false)} onPick={(pick) => {
        if ('programs' in pick) setPicked(pick.programs.filter((program) => program.duration > 0));
        setBrowsing(false);
      }} />}
    </div>
  );
}
