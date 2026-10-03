'use client';

import { useEffect, useState } from 'react';
import { makeCommercialBreak, makeFlex, makeRedirect } from '../../lib/broadcast';
import type { ListSummary } from '../../lib/library';
import type { Channel, LineupItem } from '../../lib/lineup';
import { tunarrApi } from '../../lib/tunarrClient';

type Kind = 'programs' | 'break' | 'flex' | 'redirect';

type Props = {
  live: boolean;
  anchorLabel: string;
  channels: Channel[];
  currentChannelId: string;
  onBrowse: (where: 'before' | 'after') => void;
  onInsert: (items: LineupItem[], label: string, where: 'before' | 'after') => void;
  onClose: () => void;
};

const MINUTE = 60_000;

/** Minutes and seconds entry, as a broadcast duration. */
function DurationField({ label, value, onChange }: { label: string; value: number; onChange: (ms: number) => void }) {
  const minutes = Math.floor(value / MINUTE);
  const seconds = Math.round((value % MINUTE) / 1000);
  return (
    <fieldset className="duration-field">
      <legend>{label}</legend>
      <label><input type="number" min={0} step={1} aria-label={`${label} minutes`} value={minutes} onChange={(event) => onChange(Math.max(0, Number(event.target.value)) * MINUTE + seconds * 1000)} /> min</label>
      <label><input type="number" min={0} max={59} step={1} aria-label={`${label} seconds`} value={seconds} onChange={(event) => onChange(minutes * MINUTE + Math.min(59, Math.max(0, Number(event.target.value))) * 1000)} /> sec</label>
    </fieldset>
  );
}

export function InsertDialog({ live, anchorLabel, channels, currentChannelId, onBrowse, onInsert, onClose }: Props) {
  const [kind, setKind] = useState<Kind>(live ? 'programs' : 'flex');
  const [where, setWhere] = useState<'before' | 'after'>('after');
  const [duration, setDuration] = useState(2 * MINUTE);
  const [fillerLists, setFillerLists] = useState<ListSummary[] | null>(null);
  const [chosenLists, setChosenLists] = useState<string[]>([]);
  const [cooldown, setCooldown] = useState(0);
  const targets = channels.filter((channel) => channel.id !== currentChannelId);
  const [redirectTo, setRedirectTo] = useState(targets[0]?.id ?? '');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    tunarrApi.fillerLists()
      .then((lists) => { if (!cancelled) setFillerLists(lists); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load filler lists.'); });
    return () => { cancelled = true; };
  }, [live]);

  const kinds: Array<[Kind, string, boolean]> = [
    ['programs', 'Programs from the library', live],
    ['break', 'Commercial break', live],
    ['flex', 'Flex time', true],
    ['redirect', 'Redirect to channel', targets.length > 0],
  ];

  const insert = () => {
    if (kind === 'programs') {
      onBrowse(where);
      return;
    }
    if (!(duration >= 1000)) return;
    if (kind === 'flex') onInsert([makeFlex(duration)], 'flex time', where);
    if (kind === 'break' && chosenLists.length) onInsert([makeCommercialBreak(duration, chosenLists, cooldown * MINUTE)], 'a commercial break', where);
    if (kind === 'redirect') {
      const channel = targets.find((item) => item.id === redirectTo);
      if (channel) onInsert([makeRedirect(channel, duration)], `a redirect to CH ${channel.number}`, where);
    }
  };
  const ready = kind === 'programs' || (duration >= 1000 && (kind !== 'break' || chosenLists.length > 0) && (kind !== 'redirect' || !!redirectTo));

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal insert-modal" role="dialog" aria-modal="true" aria-labelledby="insert-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">INSERT</p>
        <h2 id="insert-title">Insert into the lineup</h2>
        <div className="segmented" role="radiogroup" aria-label="What to insert">
          {kinds.map(([value, label, enabled]) => <button key={value} role="radio" aria-checked={kind === value} className={kind === value ? 'primary' : ''} disabled={!enabled} onClick={() => setKind(value)}>{label}</button>)}
        </div>
        <div className="segmented" role="radiogroup" aria-label="Where">
          <button role="radio" aria-checked={where === 'before'} className={where === 'before' ? 'primary' : ''} onClick={() => setWhere('before')}>Before {anchorLabel}</button>
          <button role="radio" aria-checked={where === 'after'} className={where === 'after' ? 'primary' : ''} onClick={() => setWhere('after')}>After {anchorLabel}</button>
        </div>

        {kind === 'programs' && <p className="subtle">Choose movies, episodes, whole seasons or shows, or other videos from your libraries. They are added to this lineup in the order you pick them.</p>}
        {kind !== 'programs' && <DurationField label="Length" value={duration} onChange={setDuration} />}
        {kind === 'flex' && <p className="subtle">Open airtime. Tunarr plays the channel’s filler or offline screen.</p>}
        {kind === 'break' && <>
          <p className="subtle">Flex time filled from the filler lists you choose, like a commercial break.</p>
          <div className="checklist" role="group" aria-label="Filler lists">
            {fillerLists === null && !error && <p className="subtle">Loading filler lists…</p>}
            {fillerLists?.length === 0 && <p className="subtle">No filler lists yet. Create one from Lists → Filler Lists…</p>}
            {fillerLists?.map((list) => (
              <label key={list.id}><input type="checkbox" checked={chosenLists.includes(list.id)} onChange={(event) => setChosenLists((current) => (event.target.checked ? [...current, list.id] : current.filter((id) => id !== list.id)))} /> {list.name}{list.contentCount != null ? <small> · {list.contentCount} items</small> : null}</label>
            ))}
          </div>
          <label className="field"><span>Don’t repeat the same filler within (minutes)</span><input type="number" min={0} step={1} value={cooldown} onChange={(event) => setCooldown(Math.max(0, Number(event.target.value)))} /></label>
        </>}
        {kind === 'redirect' && <label className="field"><span>Redirect to</span>
          <select value={redirectTo} onChange={(event) => setRedirectTo(event.target.value)}>
            {targets.map((channel) => <option key={channel.id} value={channel.id}>CH {channel.number} {channel.name}</option>)}
          </select>
        </label>}
        {error && <div className="warning" role="alert"><b>Couldn’t load filler lists</b><span>{error}</span></div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!ready} onClick={insert}>{kind === 'programs' ? 'Browse library…' : 'Insert'}</button>
        </div>
      </section>
    </div>
  );
}
