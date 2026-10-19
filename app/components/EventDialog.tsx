'use client';

import { useMemo, useState } from 'react';
import { durationTimecode, makeFlex, makeRedirect } from '../../lib/broadcast';
import { airTimeLabel as when, placeEvent, repeatLabel, type EventMode, type EventPlacement, type EventSnap } from '../../lib/events';
import { lineupEntry, type ContentProgram } from '../../lib/library';
import type { Channel, LineupItem, Programming } from '../../lib/lineup';
import { programTitle } from '../../lib/programInfo';
import { LibraryBrowser } from './LibraryBrowser';

type Props = {
  channel: Channel;
  channels: Channel[];
  lineup: LineupItem[];
  programs: Programming['programs'];
  /** yyyy-mm-dd the desk is showing. */
  date: string;
  /** The channel is generated from a slot schedule. */
  generated: boolean;
  onClose: () => void;
  onPlace: (placement: EventPlacement, label: string, meta: Record<string, ContentProgram>, date: string) => void;
  /**
   * Air the event once: the companion's scheduler puts it in just before it
   * starts and takes it out when it ends. `unavailable` says why it can't.
   */
  airOnce?: { unavailable?: string; onSchedule: (placement: EventPlacement, label: string, meta: Record<string, ContentProgram>) => Promise<void> };
};

type What = 'programs' | 'redirect' | 'flex';
const MINUTE = 60_000;
const inputDate = (ms: number) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

export function EventDialog({ channel, channels, lineup, programs, date, generated, onClose, onPlace, airOnce }: Props) {
  const [day, setDay] = useState(date);
  const [time, setTime] = useState('20:00');
  const [what, setWhat] = useState<What>('programs');
  const [picked, setPicked] = useState<ContentProgram[]>([]);
  const [redirectTo, setRedirectTo] = useState(channels.find((item) => item.id !== channel.id)?.id ?? '');
  const [minutes, setMinutes] = useState(120);
  const [name, setName] = useState('');
  const [snap, setSnap] = useState<EventSnap>('after');
  const [mode, setMode] = useState<EventMode>('replace');
  const [browsing, setBrowsing] = useState(false);
  const [once, setOnce] = useState(false);
  // When the dialog opened: "too soon to schedule" is judged against it, not re-read every render.
  const [openedAt] = useState(() => Date.now());
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState('');

  const at = new Date(`${day}T${time}:00`).getTime();
  const items = useMemo((): LineupItem[] => {
    if (what === 'programs') return picked.map((program) => lineupEntry(program).item);
    if (what === 'redirect') {
      const target = channels.find((item) => item.id === redirectTo);
      return target && minutes > 0 ? [makeRedirect(target, minutes * MINUTE)] : [];
    }
    return minutes > 0 ? [makeFlex(minutes * MINUTE)] : [];
  }, [what, picked, channels, redirectTo, minutes]);
  const placement = Number.isFinite(at) && items.length ? placeEvent(lineup, channel.startTime, at, items, mode, snap) : null;
  const title = name.trim() || (what === 'programs' ? (picked.length === 1 ? String((picked[0].program as { title?: string }).title ?? 'Event') : `${picked.length} programs`) : what === 'redirect' ? `Simulcast of CH ${channels.find((item) => item.id === redirectTo)?.number ?? ''}` : 'Off-air break');
  const removedTitles = placement?.removed.map((item) => programTitle(item, programs)) ?? [];
  const onceProblem = !airOnce ? '' : airOnce.unavailable ?? (mode !== 'replace' ? 'Only “Replace what was on” can air once: pushing would move every later program while it’s in.' : placement && placement.overrun > 0 ? 'It runs past the end of the lineup, so it can’t air once.' : placement && placement.start - 60_000 < openedAt ? 'It starts too soon to schedule.' : '');
  const airingOnce = once && !!airOnce && !onceProblem;
  const meta = () => Object.fromEntries(picked.map((program) => lineupEntry(program).meta));

  return (
    <div className="overlay" role="presentation" onKeyDown={(event) => {
      if (browsing && (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack')) {
        event.stopPropagation();
        setBrowsing(false);
      }
    }}>
      <section className="modal event-modal" role="dialog" aria-modal="true" aria-labelledby="event-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="event-title">Schedule an event</h2>
        <p className="subtle">A match, a premiere or a special on a specific date. It goes into the lineup like any edit: undo it, then save.</p>
        <div className="settings-grid">
          <label className="field"><span>Date</span><input type="date" aria-label="Event date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
          <label className="field"><span>Time</span><input type="time" aria-label="Event time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <label className="field"><span>Name (for the edit list)</span><input aria-label="Event name" value={name} placeholder="World Cup final" onChange={(event) => setName(event.target.value)} /></label>
          <label className="field"><span>What airs</span><select aria-label="What airs" value={what} onChange={(event) => setWhat(event.target.value as What)}>
            <option value="programs">Programs from the library</option>
            <option value="redirect">Another channel (simulcast)</option>
            <option value="flex">Off-air / flex time</option>
          </select></label>
          {what === 'redirect' && <label className="field"><span>Channel</span><select aria-label="Simulcast channel" value={redirectTo} onChange={(event) => setRedirectTo(event.target.value)}>
            {channels.filter((item) => item.id !== channel.id).map((item) => <option key={item.id} value={item.id}>CH {item.number} {item.name}</option>)}
          </select></label>}
          {what !== 'programs' && <label className="field"><span>Length (minutes)</span><input type="number" min={1} step={1} aria-label="Event length minutes" value={minutes} onChange={(event) => setMinutes(Math.max(0, Math.round(Number(event.target.value))))} /></label>}
        </div>
        {what === 'programs' && <div className="list-toolbar">
          <span>{picked.length ? `${picked.length} ${picked.length === 1 ? 'program' : 'programs'} · ${durationTimecode(picked.reduce((sum, program) => sum + program.duration, 0))}` : 'Nothing picked yet.'}</span>
          <button onClick={() => setBrowsing(true)}>{picked.length ? 'Change programs…' : 'Choose programs…'}</button>
        </div>}
        <div className="settings-grid">
          <label className="field"><span>If a program is still on</span><select aria-label="If a program is still on" value={snap} onChange={(event) => setSnap(event.target.value as EventSnap)}>
            <option value="after">Start when it ends</option>
            <option value="before">Start in its place (earlier)</option>
          </select></label>
          <label className="field"><span>Then</span><select aria-label="Event mode" value={mode} onChange={(event) => setMode(event.target.value as EventMode)}>
            <option value="replace">Replace what was on; later programs keep their times</option>
            <option value="push">Push everything after it later</option>
          </select></label>
        </div>

        {placement && <div className="event-preview" role="status" aria-label="Event placement">
          <b>{title}: {when(placement.start)} – {when(placement.end)}</b>
          {placement.drift !== 0 && <span>Starts {durationTimecode(Math.abs(placement.drift))} {placement.drift > 0 ? 'after' : 'before'} {time}, when {placement.drift > 0 ? 'the program on air ends' : 'the program on air starts'}. Tunarr can’t cut a program short.</span>}
          {mode === 'replace' && <span>Takes off: {removedTitles.length ? `${removedTitles.slice(0, 6).join(', ')}${removedTitles.length > 6 ? ` and ${removedTitles.length - 6} more` : ''}` : 'nothing'}{placement.pad ? `; then ${durationTimecode(placement.pad)} of flex so everything after stays on time` : ''}.</span>}
          {mode === 'replace' && placement.overrun > 0 && <span>It runs {durationTimecode(placement.overrun)} past the end of the lineup, so the lineup gets that much longer and later repeats air that much later.</span>}
          {mode === 'push' && <span>Everything after it moves {durationTimecode(placement.end - placement.start)} later.</span>}
          {airingOnce
            ? <span>Airs once. The Lineup server puts it in a few minutes before {when(placement.start)} and puts back what it replaced at {when(placement.end)}, each time only if the programs around it haven’t changed. Your lineup on screen stays as it is.</span>
            : <span>This lineup repeats {repeatLabel(placement.cycle)}, so the event also airs on {inputDate(placement.start + placement.cycle)}{placement.cycle < 14 * 86_400_000 ? ' and every repeat after that' : ''}.</span>}
          {generated && <span>Saving the slot schedule (or changing the start time) regenerates the lineup and removes the event.</span>}
        </div>}
        {!lineup.length && <p className="slot-problem">This channel has no lineup yet. Add programming first.</p>}
        {airOnce && <label className="check-toggle air-once"><input type="checkbox" checked={once} disabled={!!onceProblem} onChange={(event) => setOnce(event.target.checked)} /> Air once, then put back what it replaced{onceProblem && <small> ({onceProblem})</small>}</label>}
        {scheduleError && <div className="warning" role="alert"><b>Not scheduled</b><span>{scheduleError}</span></div>}

        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <span className="spacer" />
          {airingOnce
            ? <button className="primary" disabled={!placement || scheduling} onClick={() => {
              if (!placement || !airOnce) return;
              setScheduling(true);
              setScheduleError('');
              airOnce.onSchedule(placement, title, meta()).catch((error) => setScheduleError(error instanceof Error ? error.message : 'The Lineup server didn’t accept it.')).finally(() => setScheduling(false));
            }}>{scheduling ? 'Scheduling…' : 'Schedule to air once'}</button>
            : <button className="primary" disabled={!placement} onClick={() => placement && onPlace(placement, title, meta(), inputDate(placement.start))}>Place event</button>}
        </div>
      </section>
      {browsing && <LibraryBrowser title="Programs for the event" mode="programs" confirmLabel="Use" onClose={() => setBrowsing(false)} onPick={(pick) => {
        if ('programs' in pick) setPicked(pick.programs.filter((program) => program.duration > 0));
        setBrowsing(false);
      }} />}
    </div>
  );
}
