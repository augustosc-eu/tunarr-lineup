'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { channelStatus, checkBatches, checkStream, filterCounts, HEALTH_LABELS, matchesFilter, minutesLeft, nextFilter, ROOM_FILTERS, ROOM_REFRESH_MS, stepRow, summaryNotes, timeLabel, type ChannelSummary, type ControlRoomSummary, type RoomFilter, type StreamCheck } from '../../lib/controlRoom';
import { rowWindow } from '../../lib/rowWindow';
import { isAborted, streamUrl, tunarrApi, type ChannelDiagnostic } from '../../lib/tunarrClient';

export type RoomAction = 'open' | 'guide' | 'watch' | 'check' | 'snapshots' | 'scheduled' | 'repair';

type Props = {
  now: number;
  activeChannelId: string;
  /** Opens a channel in the desk, the guide, Watch Live, its lineup check, snapshots or the scheduled changes. */
  onAction: (action: RoomAction, channelId: string) => void;
  onClose: () => void;
};

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const MOUNTED_ROWS = 120;

const ACTIONS: Array<{ id: RoomAction; label: string }> = [
  { id: 'open', label: 'Open in the desk' },
  { id: 'guide', label: 'Guide grid' },
  { id: 'watch', label: 'Watch live' },
  { id: 'check', label: 'Check lineup' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'scheduled', label: 'Scheduled changes' },
];

function nowLine(channel: ChannelSummary, now: number) {
  if (!channel.now) return channel.guide === 'ok' || channel.guide === 'empty' ? 'Nothing in the guide now' : 'Guide not read';
  return `${channel.now.title} · ${minutesLeft(channel.now.stop, now)} min left`;
}

function checkLine(diagnostic: ChannelDiagnostic | null) {
  if (!diagnostic) return 'Not checked';
  if (diagnostic.error) return `Check failed: ${diagnostic.error}`;
  const errors = diagnostic.findings.filter((finding) => finding.severity === 'error').length;
  const warnings = diagnostic.findings.filter((finding) => finding.severity === 'warning').length;
  const mode = { manual: 'Manual lineup', generated: 'Slot schedule', empty: 'Empty', unknown: '' }[diagnostic.mode];
  const found = errors || warnings ? [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ') : 'No problems found';
  return `${mode ? `${mode} · ` : ''}${found} · ${timeLabel(diagnostic.checkedAt)}`;
}

/**
 * View → Control Room: every channel's state at once. The summary (now/next,
 * viewers, guide, scheduled changes, last check) refreshes every minute while
 * the page is visible; the deeper check and the stream check run only when
 * asked. ↑ ↓ PgUp PgDn move, OK or → opens the channel's actions, F changes
 * the filter, R refreshes, C checks the channel, A checks every channel shown,
 * S checks its stream, Back steps out, then closes.
 */
export function ControlRoomDialog({ now, activeChannelId, onAction, onClose }: Props) {
  const [summary, setSummary] = useState<ControlRoomSummary | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RoomFilter>('all');
  const [focusId, setFocusId] = useState(activeChannelId);
  const [inActions, setInActions] = useState(false);
  const [streams, setStreams] = useState<Record<string, StreamCheck>>({});
  const [streamBusy, setStreamBusy] = useState('');
  const [checking, setChecking] = useState<{ done: number; total: number } | null>(null);
  const [checkError, setCheckError] = useState('');
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const actionsRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const loadAbort = useRef<AbortController | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const loadedAt = useRef(0);

  /** Reads the summary; `load` also shows that it's refreshing (the first read starts that way). */
  const fetchSummary = () => {
    loadAbort.current?.abort();
    const controller = new AbortController();
    loadAbort.current = controller;
    tunarrApi.controlRoom({ signal: controller.signal, timeoutMs: 45_000 })
      .then((next) => { loadedAt.current = Date.now(); setSummary(next); setError(''); })
      .catch((reason) => { if (!isAborted(reason)) setError(errorText(reason)); })
      .finally(() => { if (loadAbort.current === controller) setLoading(false); });
  };
  const load = () => {
    setLoading(true);
    fetchSummary();
  };

  // A prudent refresh: every minute, only while the page is visible, and once on coming back if it's stale.
  useEffect(() => {
    fetchSummary();
    const tick = () => { if (document.visibilityState === 'visible' && Date.now() - loadedAt.current >= ROOM_REFRESH_MS) load(); };
    const timer = window.setInterval(tick, ROOM_REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      loadAbort.current?.abort();
      checkAbort.current?.abort();
      streamAbort.current?.abort();
    };
    // Mount only: `load` touches only refs and state setters, so this first copy stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const all = useMemo(() => (summary?.channels ?? []).map((channel) => ({ channel, status: channelStatus(channel, summary!, streams[channel.id]) })), [summary, streams]);
  const counts = useMemo(() => filterCounts(all), [all]);
  const rows = useMemo(() => all.filter((row) => matchesFilter(filter, row.channel, row.status)), [all, filter]);
  const focusIndex = Math.max(0, rows.findIndex((row) => row.channel.id === focusId));
  const focused = rows[focusIndex];
  const range = rowWindow(rows.length, focusIndex, null, MOUNTED_ROWS);

  // Keep keyboard focus on the focused row (or inside the actions while they're open).
  useEffect(() => {
    if (inActions) return;
    const element = focused ? rowRefs.current.get(focused.channel.id) : null;
    if (element) {
      if (sectionRef.current?.contains(document.activeElement) || document.activeElement === document.body || !document.activeElement) {
        element.focus({ preventScroll: true });
        element.scrollIntoView?.({ block: 'nearest' });
      }
    } else if (!sectionRef.current?.contains(document.activeElement)) sectionRef.current?.focus({ preventScroll: true });
  }, [focused, inActions]);

  const applyDiagnostics = (diagnostics: ChannelDiagnostic[]) => setSummary((current) => current && {
    ...current,
    channels: current.channels.map((channel) => ({ ...channel, diagnostic: diagnostics.find((item) => item.channelId === channel.id) ?? channel.diagnostic })),
  });

  /** The deep check, in batches the companion accepts; Cancel stops before the next batch. */
  const check = async (ids: string[]) => {
    if (!ids.length || checking) return;
    checkAbort.current?.abort();
    const controller = new AbortController();
    checkAbort.current = controller;
    setCheckError('');
    setChecking({ done: 0, total: ids.length });
    let done = 0;
    try {
      for (const batch of checkBatches(ids)) {
        if (controller.signal.aborted) break;
        const { diagnostics } = await tunarrApi.checkChannels(batch, { signal: controller.signal, timeoutMs: 180_000 });
        applyDiagnostics(diagnostics);
        done += batch.length;
        setChecking({ done, total: ids.length });
      }
    } catch (reason) {
      if (!isAborted(reason)) setCheckError(errorText(reason));
    } finally {
      if (checkAbort.current === controller) setChecking(null);
    }
  };

  const checkFocusedStream = async () => {
    if (!focused || streamBusy) return;
    const id = focused.channel.id;
    streamAbort.current?.abort();
    const controller = new AbortController();
    streamAbort.current = controller;
    setStreamBusy(id);
    const result = await checkStream(streamUrl(id), controller.signal);
    setStreams((current) => ({ ...current, [id]: result }));
    setStreamBusy('');
  };

  const leaveActions = () => {
    setInActions(false);
    if (focused) rowRefs.current.get(focused.channel.id)?.focus({ preventScroll: true });
  };
  const enterActions = () => {
    if (!focused) return;
    setInActions(true);
    // The focused channel's actions are already on screen: focus the first now, so keys pressed next land there.
    actionsRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (back(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (inActions) leaveActions();
      else onClose();
      return;
    }
    if (event.altKey || event.metaKey || event.ctrlKey || (event.target as HTMLElement).closest('input, select, textarea')) return;
    if (inActions) {
      if (key === 'ArrowLeft') { event.preventDefault(); leaveActions(); }
      else if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...(actionsRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      return;
    }
    if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'ChannelDown', 'ChannelUp', 'Home', 'End'].includes(key)) {
      event.preventDefault();
      const next = rows[stepRow(focusIndex, rows.length, key)];
      if (next) setFocusId(next.channel.id);
    } else if ((key === 'Enter' || key === 'ArrowRight') && (event.target as HTMLElement).closest('.room-row')) {
      event.preventDefault();
      enterActions();
    } else if (key === 'f' || key === 'F') { event.preventDefault(); setFilter(nextFilter(filter)); }
    else if (key === 'r' || key === 'R') { event.preventDefault(); load(); }
    else if ((key === 'c' || key === 'C') && focused) { event.preventDefault(); void check([focused.channel.id]); }
    else if (key === 'a' || key === 'A') { event.preventDefault(); void check(rows.map((row) => row.channel.id)); }
    else if ((key === 's' || key === 'S') && focused) { event.preventDefault(); void checkFocusedStream(); }
  };

  const parts = summary ? ([['Guide', summary.guide], ['Viewer counts', summary.sessions], ['Programming', summary.programming]] as const).filter(([, part]) => part.status !== 'ok') : [];
  const detail = focused?.channel;
  const findings = detail?.diagnostic?.findings ?? [];

  return (
    <div className="overlay room-overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} tabIndex={-1} className="modal control-room-modal" role="dialog" aria-modal="true" aria-labelledby="room-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="room-head">
          <h2 id="room-title">Control Room</h2>
          <span className="subtle" aria-live="polite">{loading ? 'Refreshing…' : summary ? `Updated ${timeLabel(summary.at)}` : ''}</span>
          <span className="room-controls">
            <button onClick={load} disabled={loading}>Refresh</button>
            {checking
              ? <button onClick={() => checkAbort.current?.abort()}>Cancel check ({checking.done}/{checking.total})</button>
              : <button disabled={!rows.length} onClick={() => void check(rows.map((row) => row.channel.id))}>Check {filter === 'all' ? 'all' : 'shown'} ({rows.length})</button>}
          </span>
        </div>
        {error && <div className="warning" role="alert"><b>Couldn’t load the Control Room</b><span>{error}</span><button onClick={load}>Try again</button></div>}
        {checkError && <div className="warning" role="alert"><b>Check stopped</b><span>{checkError}</span></div>}
        {parts.map(([label, part]) => <div key={label} className="warning" role="note"><b>{label}</b><span>{'message' in part ? part.message : ''}</span></div>)}
        <div className="room-filters" role="toolbar" aria-label="Show">
          {ROOM_FILTERS.map((item) => (
            <button key={item.id} aria-pressed={filter === item.id} className={filter === item.id ? 'primary' : ''} onClick={() => setFilter(item.id)}>{item.label} ({counts[item.id]})</button>
          ))}
        </div>
        <div className="room-body">
          <ul className="room-list" aria-label="Channels" aria-busy={!summary && !error}>
            {!summary && !error && <li className="issue-empty">Loading every channel…</li>}
            {summary && !rows.length && <li className="issue-empty">No channels match “{ROOM_FILTERS.find((item) => item.id === filter)?.label}”.</li>}
            {range.start > 0 && <li className="issue-empty">{range.start} more above</li>}
            {rows.slice(range.start, range.end).map(({ channel, status }) => (
              <li key={channel.id}>
                <button
                  ref={(element) => { if (element) rowRefs.current.set(channel.id, element); else rowRefs.current.delete(channel.id); }}
                  className={`room-row issue health-${status} ${channel.id === focused?.channel.id ? 'focused' : ''}`}
                  tabIndex={channel.id === focused?.channel.id ? 0 : -1}
                  aria-label={`CH ${channel.number} ${channel.name}: ${HEALTH_LABELS[status]}. ${nowLine(channel, now)}. ${channel.viewers} watching. ${checkLine(channel.diagnostic)}`}
                  onFocus={() => setFocusId(channel.id)}
                  onClick={() => { setFocusId(channel.id); enterActions(); }}
                >
                  <em className="issue-badge">{HEALTH_LABELS[status]}</em>
                  <span className="room-channel"><b>{channel.number} {channel.name}</b><small>{channel.group || ' '}</small></span>
                  <span className="room-now"><b>{nowLine(channel, now)}</b><small>{channel.next ? `Next ${timeLabel(channel.next.start)} · ${channel.next.title}` : ' '}</small></span>
                  <span className="room-stats">
                    {(channel.viewers > 0 || channel.streams > 0) && <em className="viewer-badge" aria-hidden="true">● {channel.viewers}</em>}
                    {channel.pendingChanges > 0 && <small>{channel.pendingChanges} scheduled</small>}
                  </span>
                </button>
              </li>
            ))}
            {range.end < rows.length && <li className="issue-empty">{rows.length - range.end} more below</li>}
          </ul>
          <aside className="room-detail" aria-label="Channel details">
            {!detail ? <p className="subtle">Pick a channel.</p> : <>
              <h3 className="section-title">CH {detail.number} {detail.name}</h3>
              <div className="info-row"><span>Status</span><b>{HEALTH_LABELS[focused.status]}</b></div>
              <div className="info-row"><span>On now</span><b>{nowLine(detail, now)}</b></div>
              <div className="info-row"><span>Viewers</span><b>{detail.viewers} watching · {detail.streams} stream{detail.streams === 1 ? '' : 's'}</b></div>
              <div className="info-row"><span>Scheduled</span><b>{detail.pendingChanges ? `${detail.pendingChanges} waiting · next ${timeLabel(detail.nextChangeAt!)}` : 'Nothing waiting'}</b></div>
              <div className="info-row"><span>Last check</span><b>{checkLine(detail.diagnostic)}</b></div>
              <ul className="room-findings" aria-label="Findings">
                {summaryNotes(detail, streams[detail.id]).map((note) => <li key={note} className="severity-warning"><span>{note}</span></li>)}
                {findings.slice(0, 8).map((finding) => <li key={finding.id} className={`severity-${finding.severity}`}><em className="issue-badge">{finding.severity}</em><span><b>{finding.title}</b><small>{finding.detail}</small></span></li>)}
                {findings.length > 8 && <li><small>{findings.length - 8} more in the lineup check.</small></li>}
              </ul>
              <div className="room-actions" ref={actionsRef} role="group" aria-label={`Actions for CH ${detail.number}`}>
                {ACTIONS.map((action) => <button key={action.id} onClick={() => onAction(action.id, detail.id)}>{action.label}</button>)}
                {findings.some((finding) => finding.id === 'missing-program') && <button onClick={() => onAction('repair', detail.id)}>Repair missing media…</button>}
                <button disabled={!!checking} onClick={() => void check([detail.id])}>Check this channel</button>
                <button disabled={!!streamBusy} onClick={() => void checkFocusedStream()}>{streamBusy === detail.id ? 'Checking stream…' : 'Check stream'}</button>
              </div>
              <p className="subtle">The stream check asks for the playlist only (no video), but Tunarr starts the channel for a moment to answer.</p>
            </>}
          </aside>
        </div>
        <p className="hint">↑ ↓ channels · PgUp PgDn page · OK actions · F filter · R refresh · C check · A check shown · S stream · Back closes</p>
      </section>
    </div>
  );
}
