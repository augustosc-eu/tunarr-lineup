'use client';

import { useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import { cycleDuration, type Channel, type LineupItem } from '../../lib/lineup';

export type PlanKind = 'save' | 'overlay';

type Props = {
  kind: PlanKind;
  channel: Channel;
  /** The lineup that goes in (the desk's edits, or a slot preview's lineup). */
  lineup: LineupItem[];
  /** Where it came from, for the dialog's text. */
  source: 'edits' | 'preview';
  hasSchedule: boolean;
  enabled: boolean;
  disabledMessage?: string;
  onPlan: (plan: { label: string; at: number; until?: number }) => Promise<void>;
  onClose: () => void;
};

const localInput = (ms: number) => {
  const date = new Date(ms);
  return { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, time: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` };
};

/**
 * Save Later (the lineup goes in on a date) and Seasonal Overlay (it goes in on
 * one date and the lineup it replaced comes back on another). The companion's
 * scheduler saves them; nothing changes in Tunarr now.
 */
export function PlanDialog({ kind, channel, lineup, source, hasSchedule, enabled, disabledMessage, onPlan, onClose }: Props) {
  const [openedAt] = useState(() => Date.now());
  const tomorrow = localInput(new Date(openedAt).setHours(24, 0, 0, 0));
  const [day, setDay] = useState(tomorrow.day);
  const [time, setTime] = useState('06:00');
  const [endDay, setEndDay] = useState(() => localInput(new Date(openedAt).setHours(24 * 8, 0, 0, 0)).day);
  const [endTime, setEndTime] = useState('06:00');
  const [label, setLabel] = useState(kind === 'overlay' ? 'Holiday programming' : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const at = new Date(`${day}T${time}:00`).getTime();
  const until = new Date(`${endDay}T${endTime}:00`).getTime();
  const problem = !Number.isFinite(at) || at < openedAt ? 'Pick a time in the future.'
    : kind === 'overlay' && (!Number.isFinite(until) || until <= at) ? 'The overlay must end after it begins.'
    : !label.trim() ? 'Give it a name.' : '';

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal plan-modal" role="dialog" aria-modal="true" aria-labelledby="plan-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="plan-title">{kind === 'overlay' ? 'Seasonal overlay' : 'Save later'}</h2>
        <p className="subtle">
          {kind === 'overlay'
            ? `${source === 'preview' ? 'The previewed lineup' : 'This lineup, with your edits,'} goes in on the first date, and the lineup it replaced comes back on the second. `
            : `${source === 'preview' ? 'The previewed lineup' : 'This lineup, with your edits,'} is saved to Tunarr on the date you pick. `}
          It goes in only if the channel is still as it is now; any change in between and it’s skipped, never forced.
        </p>
        {!enabled && <div className="warning"><b>Scheduled changes are off</b><span>{disabledMessage}</span></div>}
        <div className="settings-grid">
          <label className="field wide-field"><span>Name</span><input aria-label="Plan name" value={label} placeholder={kind === 'overlay' ? 'Christmas week' : 'Fall schedule'} onChange={(event) => setLabel(event.target.value)} /></label>
          <label className="field"><span>{kind === 'overlay' ? 'Begins on' : 'Save on'}</span><input type="date" aria-label="Plan date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
          <label className="field"><span>at</span><input type="time" aria-label="Plan time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          {kind === 'overlay' && <>
            <label className="field"><span>Ends on</span><input type="date" aria-label="Overlay end date" value={endDay} onChange={(event) => setEndDay(event.target.value)} /></label>
            <label className="field"><span>at</span><input type="time" aria-label="Overlay end time" value={endTime} onChange={(event) => setEndTime(event.target.value)} /></label>
          </>}
        </div>
        <div className="event-preview" role="status">
          <b>{lineup.length.toLocaleString('en')} lineup items · {durationTimecode(cycleDuration(lineup))} cycle</b>
          <span>The lineup repeats from the channel’s start time, as any manual lineup does, so what airs at {time} depends on where the cycle is then.</span>
          {hasSchedule && <span>This channel has a slot schedule. Tunarr keeps it; if it regenerates the lineup in between, the change is skipped.</span>}
          {source === 'edits' && <span>Your edits stay in the desk as unsaved changes. Revert them if you don’t want to save them now as well.</span>}
        </div>
        {error && <div className="warning" role="alert"><b>Not scheduled</b><span>{error}</span></div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!enabled || !!problem || busy || !lineup.length} title={problem} onClick={() => {
            setBusy(true);
            setError('');
            onPlan({ label: label.trim(), at, until: kind === 'overlay' ? until : undefined })
              .catch((reason) => setError(reason instanceof Error ? reason.message : 'The Lineup server didn’t accept it.'))
              .finally(() => setBusy(false));
          }}>{busy ? 'Scheduling…' : kind === 'overlay' ? 'Schedule overlay' : 'Schedule save'}</button>
        </div>
        {problem && <p className="hint">{problem}</p>}
      </section>
    </div>
  );
}
