'use client';

import { useEffect, useRef, useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import type { Channel, LineupItem, Programming } from '../../lib/lineup';
import { tunarrApi, type SnapshotSummary } from '../../lib/tunarrClient';

type Props = {
  channel: Channel;
  live: boolean;
  /** Tunarr's lineup as loaded (what an export contains), and its programs for titles. */
  lineup: LineupItem[];
  programs: Programming['programs'];
  hasSchedule: boolean;
  /** Loads a lineup into the desk as one edit (saved like any other). */
  onRestore: (lineup: LineupItem[], programs: Record<string, unknown>, label: string) => void;
  onClose: () => void;
};

const when = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
const ITEM_TYPES = new Set(['content', 'custom', 'filler', 'flex', 'redirect']);

/** A lineup read from an exported file, or what's wrong with it. Items must look like Tunarr's. */
export function readExport(text: string): { lineup: LineupItem[]; programs: Record<string, unknown>; channelName?: string } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: 'That file isn’t JSON.' };
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const lineup = record.lineup;
  if (record.kind !== 'tunarr-lineup-export' || !Array.isArray(lineup)) return { error: 'That isn’t a lineup exported from Tunarr Lineup.' };
  for (const [index, item] of lineup.entries()) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string' || !ITEM_TYPES.has(entry.type) || typeof entry.duration !== 'number' || !(entry.duration > 0)) {
      return { error: `Item ${index + 1} in the file isn’t a lineup item Tunarr accepts.` };
    }
  }
  const programs = record.programs && typeof record.programs === 'object' && !Array.isArray(record.programs) ? (record.programs as Record<string, unknown>) : {};
  return { lineup: lineup as LineupItem[], programs, channelName: typeof record.channelName === 'string' ? record.channelName : undefined };
}

/**
 * Snapshots the companion took before each save, a snapshot taken now, and a
 * lineup exported to (or imported from) a file. Restoring loads the lineup into
 * the desk as an edit: nothing reaches Tunarr until it's saved.
 */
export function SnapshotsDialog({ channel, live, lineup, programs, hasSchedule, onRestore, onClose }: Props) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const reload = () => {
    if (!live) return;
    tunarrApi.snapshots(channel.id).then(setSnapshots).catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t read the snapshots.'));
  };
  useEffect(reload, [channel.id, live]);

  const restore = (summary: SnapshotSummary) => {
    setBusy(true);
    tunarrApi.snapshot(channel.id, summary.id)
      .then((snapshot) => onRestore(snapshot.lineup as LineupItem[], snapshot.programs, `Restored the lineup from ${when(snapshot.takenAt)}`))
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t read that snapshot.'))
      .finally(() => setBusy(false));
  };

  const takeNow = () => {
    setBusy(true);
    tunarrApi.takeSnapshot(channel.id)
      .then((result) => { setNote('unchanged' in result ? result.message : 'Snapshot taken.'); reload(); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t take a snapshot.'))
      .finally(() => setBusy(false));
  };

  const remove = (summary: SnapshotSummary) => {
    tunarrApi.deleteSnapshot(channel.id, summary.id).then(reload).catch((reason) => setError(reason instanceof Error ? reason.message : 'Couldn’t delete it.'));
  };

  const exportFile = () => {
    const used: Record<string, unknown> = {};
    for (const item of lineup) if (item.id && programs[item.id]) used[item.id] = programs[item.id];
    const body = JSON.stringify({ kind: 'tunarr-lineup-export', version: 1, exportedAt: new Date().toISOString(), channelName: channel.name, channelNumber: channel.number, lineup, programs: used }, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `lineup-ch${channel.number}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNote(`Exported ${lineup.length} lineup items.`);
  };

  const importFile = (picked: File | undefined) => {
    if (!picked) return;
    picked.text().then((text) => {
      const read = readExport(text);
      if ('error' in read) setError(read.error);
      else onRestore(read.lineup, read.programs, `Imported the lineup from ${picked.name}`);
    }).catch(() => setError('That file couldn’t be read.'));
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal snapshots-modal" role="dialog" aria-modal="true" aria-labelledby="snapshots-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="snapshots-title">Snapshots</h2>
        <p className="subtle">The Lineup server keeps the lineup as it was before every save, reset and scheduled change, the last {15} per channel. Restoring puts it in the desk as one edit: check it, then save.{hasSchedule ? ' This channel has a slot schedule; restoring brings back the lineup only.' : ''}</p>
        {error && <div className="warning" role="alert"><b>Something went wrong</b><span>{error}</span></div>}
        {note && <p className="hint" role="status">{note}</p>}
        {live && <ol className="snapshot-list" aria-label="Snapshots">
          {snapshots === null && !error && <li className="issue-empty">Reading snapshots…</li>}
          {snapshots?.length === 0 && <li className="issue-empty">No snapshots yet. One is taken before the next save.</li>}
          {snapshots?.map((summary) => (
            <li key={summary.id}>
              <span><b>{when(summary.takenAt)}</b><small>{summary.reason} · {summary.items.toLocaleString('en')} items · {durationTimecode(summary.length)}{summary.hadSchedule ? ' · had a slot schedule' : ''}</small></span>
              <button disabled={busy} onClick={() => restore(summary)}>Restore…</button>
              <button disabled={busy} aria-label={`Delete snapshot from ${when(summary.takenAt)}`} onClick={() => remove(summary)}>Delete</button>
            </li>
          ))}
        </ol>}
        {!live && <p className="hint">Demo mode keeps no snapshots.</p>}
        <div className="list-toolbar">
          <span>Files: keep a copy anywhere, or move a lineup between Lineup servers.</span>
          <span className="toolbar-buttons">
            <button disabled={!lineup.length} onClick={exportFile}>Export to a file</button>
            <button onClick={() => file.current?.click()}>Import a file…</button>
            <input ref={file} type="file" accept="application/json,.json" hidden aria-label="Lineup file to import" onChange={(event) => { importFile(event.target.files?.[0]); event.target.value = ''; }} />
          </span>
        </div>
        <div className="dialog-actions">
          {live && <button disabled={busy} onClick={takeNow}>Take a snapshot now</button>}
          <span className="spacer" />
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
