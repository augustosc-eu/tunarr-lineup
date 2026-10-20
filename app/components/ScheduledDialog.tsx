'use client';

import { useEffect, useState } from 'react';
import { tunarrApi, type ChangeSummary, type ScheduledList } from '../../lib/tunarrClient';

type Props = {
  live: boolean;
  /** Channel id → label, for changes on other channels. */
  channelLabel: (id: string, fallback: string) => string;
  onClose: () => void;
};

const when = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const GROUP_LABELS: Record<ChangeSummary['group'], string> = { save: 'Dated save', event: 'Airs once', overlay: 'Seasonal overlay', premiere: 'Premiere' };
const STATUS_LABELS: Record<ChangeSummary['status'], string> = { pending: 'Waiting', done: 'Done', skipped: 'Skipped', failed: 'Failed', cancelled: 'Cancelled' };

/** Every change waiting to be saved on a date, on any channel, and what happened to recent ones. */
export function ScheduledDialog({ live, channelLabel, onClose }: Props) {
  const [list, setList] = useState<ScheduledList | null>(null);
  const [error, setError] = useState('');

  const reload = () => {
    if (!live) return;
    tunarrApi.scheduled().then(setList).catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t read scheduled changes.'));
  };
  useEffect(reload, [live]);

  const cancel = (change: ChangeSummary) => {
    tunarrApi.cancelScheduled(change.id).then(reload).catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t cancel it.'));
  };

  const pending = list?.changes.filter((change) => change.status === 'pending') ?? [];
  const finished = list?.changes.filter((change) => change.status !== 'pending').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)).slice(0, 30) ?? [];
  const row = (change: ChangeSummary) => (
    <li key={change.id} className={`change status-${change.status}`}>
      <span>
        <b>{when(change.at)} · {change.label}</b>
        <small>{GROUP_LABELS[change.group]} · {channelLabel(change.channelId, change.channelName)} · {change.kind === 'restore' ? 'puts the earlier lineup back' : `${change.items} ${change.items === 1 ? 'item' : 'items'}`}{change.status !== 'pending' ? ` · ${STATUS_LABELS[change.status]}${change.message ? `: ${change.message}` : ''}` : ''}</small>
      </span>
      {change.status === 'pending' && <button onClick={() => cancel(change)} aria-label={`Cancel ${change.label}`}>Cancel</button>}
    </li>
  );

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal scheduled-modal" role="dialog" aria-modal="true" aria-labelledby="scheduled-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <h2 id="scheduled-title">Scheduled changes</h2>
        <p className="subtle">The Lineup server saves these to Tunarr when they’re due, each only if the channel is as it was when planned. Cancelling one half of an event or overlay cancels the other.</p>
        {!live && <p className="hint">Demo mode has no scheduled changes.</p>}
        {error && <div className="warning" role="alert"><b>Something went wrong</b><span>{error}</span></div>}
        {list && !list.enabled && <div className="warning"><b>Scheduled changes are off</b><span>{list.message}</span></div>}
        {live && <>
          <h3 className="list-heading">Waiting ({pending.length})</h3>
          <ol className="change-list" aria-label="Waiting changes">
            {!list && !error && <li className="issue-empty">Reading…</li>}
            {list && !pending.length && <li className="issue-empty">Nothing is waiting. Use File → Save Later… or Save as Seasonal Overlay…, or “Air once” when scheduling an event.</li>}
            {pending.map(row)}
          </ol>
          {finished.length > 0 && <>
            <h3 className="list-heading">Recent</h3>
            <ol className="change-list" aria-label="Recent changes">{finished.map(row)}</ol>
          </>}
        </>}
        <div className="dialog-actions">
          {live && <button onClick={reload}>Refresh</button>}
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
