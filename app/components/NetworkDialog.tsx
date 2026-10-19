'use client';

import { useEffect, useMemo, useState } from 'react';
import { durationTimecode, makeRedirect } from '../../lib/broadcast';
import { airTimeLabel as when, boundaryAt, placeEvent } from '../../lib/events';
import { cycleDuration, type Channel, type LineupItem, type Programming } from '../../lib/lineup';
import { programTitle } from '../../lib/programInfo';
import { programmingVersion } from '../../server/lineupVersion';
import { tunarrApi, TunarrApiError } from '../../lib/tunarrClient';

export type NetworkMode = 'copy' | 'simulcast' | 'commercials';

type Props = {
  mode: NetworkMode;
  source: Channel;
  channels: Channel[];
  /** The selected block, its items exactly as in the lineup, and when it airs. */
  block: { items: LineupItem[]; start: number | null };
  programs: Programming['programs'];
  /** Channels with unsaved work in the desk; saving to them makes that work stale. */
  drafts: Record<string, boolean>;
  onDone: (message: string, changedIds: string[]) => void;
  onClose: () => void;
};

type Target = { channel: Channel; lineup: LineupItem[]; version: string; generated: boolean };
type Where = 'end' | 'start' | 'time';
type Result = { id: string; label: string; ok: boolean; message: string };

const MODE_TITLES: Record<NetworkMode, string> = { copy: 'Copy to another channel', simulcast: 'Simulcast on the network', commercials: 'Share commercials with the network' };
const label = (channel: Channel) => `CH ${channel.number} ${channel.name}`;
const errorText = (error: unknown) => (error instanceof TunarrApiError && error.code === 'lineup_changed' ? 'It changed in Tunarr while this was open; nothing was saved there.' : error instanceof Error ? error.message : 'Not saved.');

async function loadTarget(channel: Channel): Promise<Target> {
  const data = await tunarrApi.programming(channel.id);
  const lineup = Array.isArray(data?.lineup) ? data.lineup : [];
  return { channel, lineup, version: programmingVersion(data?.lineup, data?.schedule), generated: data?.schedule != null };
}

/**
 * Work across channels, each saved to that channel with its own conditional
 * save: copy the selected block to another channel; simulcast it (a redirect
 * to this channel at the same time) on every channel of the network, which is
 * Tunarr's group title; or give the network this channel's commercial settings.
 */
export function NetworkDialog({ mode, source, channels, block, programs, drafts, onDone, onClose }: Props) {
  const network = source.groupTitle?.trim() ?? '';
  const others = channels.filter((channel) => channel.id !== source.id);
  const inNetwork = others.filter((channel) => (channel.groupTitle?.trim() ?? '') === network);
  const [targetId, setTargetId] = useState(others[0]?.id ?? '');
  const [picked, setPicked] = useState<string[]>(() => inNetwork.map((channel) => channel.id));
  const [targets, setTargets] = useState<Record<string, Target | { error: string }>>({});
  const [where, setWhere] = useState<Where>('time');
  const [day, setDay] = useState(() => { const date = new Date(block.start ?? Date.now()); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; });
  const [time, setTime] = useState(() => (block.start ? `${String(new Date(block.start).getHours()).padStart(2, '0')}:${String(new Date(block.start).getMinutes()).padStart(2, '0')}` : '20:00'));
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const length = cycleDuration(block.items);

  // Lineups of the channels involved, for previews and the saves' versions.
  const needed = useMemo(() => (mode === 'copy' ? [targetId].filter(Boolean) : mode === 'simulcast' ? picked : []), [mode, targetId, picked]);
  useEffect(() => {
    let cancelled = false;
    for (const id of needed) {
      if (targets[id]) continue;
      const channel = channels.find((item) => item.id === id);
      if (!channel) continue;
      loadTarget(channel)
        .then((target) => { if (!cancelled) setTargets((current) => ({ ...current, [id]: target })); })
        .catch((error) => { if (!cancelled) setTargets((current) => ({ ...current, [id]: { error: errorText(error) } })); });
    }
    return () => { cancelled = true; };
  }, [needed, targets, channels]);

  // Copy: where the block lands in the target.
  const copyTarget = targets[targetId];
  const copyPlan = (() => {
    if (mode !== 'copy' || !copyTarget || 'error' in copyTarget) return null;
    const { lineup, channel } = copyTarget;
    if (where === 'start') return { index: 0, start: null as number | null };
    if (where === 'end' || !lineup.length) return { index: lineup.length, start: null };
    const at = new Date(`${day}T${time}:00`).getTime();
    const boundary = Number.isFinite(at) ? boundaryAt(lineup, channel.startTime, at, 'after', length) : null;
    return boundary ? { index: boundary.index, start: boundary.start } : null;
  })();
  const redirectsToTarget = block.items.some((item) => item.type === 'redirect' && item.channel === targetId);

  // Simulcast: a redirect to this channel on each picked channel, at the block's time.
  const blockStart = block.start;
  const simulcastPlans = mode !== 'simulcast' || blockStart === null ? [] : picked.flatMap((id) => {
    const target = targets[id];
    if (!target || 'error' in target) return [];
    const placement = placeEvent(target.lineup, target.channel.startTime, blockStart, [makeRedirect(source, length)], 'replace', 'after');
    return placement ? [{ target, placement }] : [];
  });

  const run = async () => {
    setBusy(true);
    const done: Result[] = [];
    const changed: string[] = [];
    try {
      if (mode === 'copy' && copyPlan && copyTarget && !('error' in copyTarget)) {
        const lineup = [...copyTarget.lineup.slice(0, copyPlan.index), ...block.items, ...copyTarget.lineup.slice(copyPlan.index)].filter((item) => item.duration > 0);
        try {
          await tunarrApi.saveProgramming(copyTarget.channel.id, { type: 'manual', lineup, append: false }, copyTarget.version);
          done.push({ id: copyTarget.channel.id, label: label(copyTarget.channel), ok: true, message: `Copied ${block.items.length} ${block.items.length === 1 ? 'item' : 'items'}.` });
          changed.push(copyTarget.channel.id);
        } catch (error) {
          done.push({ id: copyTarget.channel.id, label: label(copyTarget.channel), ok: false, message: errorText(error) });
        }
      } else if (mode === 'simulcast') {
        for (const { target, placement } of simulcastPlans) {
          try {
            await tunarrApi.saveProgramming(target.channel.id, { type: 'manual', lineup: placement.lineup.filter((item) => item.duration > 0), append: false }, target.version);
            done.push({ id: target.channel.id, label: label(target.channel), ok: true, message: `Simulcasts ${when(placement.start)}.` });
            changed.push(target.channel.id);
          } catch (error) {
            done.push({ id: target.channel.id, label: label(target.channel), ok: false, message: errorText(error) });
          }
        }
      } else if (mode === 'commercials') {
        const settings = await tunarrApi.channelSettings(source.id);
        for (const id of picked) {
          const channel = channels.find((item) => item.id === id);
          if (!channel) continue;
          try {
            await tunarrApi.saveChannelSettings(id, { fillerCollections: settings.fillerCollections ?? [], fillerRepeatCooldown: settings.fillerRepeatCooldown, disableFillerOverlay: settings.disableFillerOverlay });
            done.push({ id, label: label(channel), ok: true, message: `${settings.fillerCollections?.length ?? 0} filler lists.` });
          } catch (error) {
            done.push({ id, label: label(channel), ok: false, message: errorText(error) });
          }
        }
      }
    } catch (error) {
      done.push({ id: source.id, label: label(source), ok: false, message: errorText(error) });
    } finally {
      setBusy(false);
      setResults(done);
    }
    const saved = done.filter((result) => result.ok).length;
    if (saved) onDone(`${MODE_TITLES[mode]}: saved to ${saved} ${saved === 1 ? 'channel' : 'channels'}${saved < done.length ? `, ${done.length - saved} not saved` : ''}.`, changed);
  };

  const pickList = (list: Channel[]) => (
    <fieldset className="pick-lists network-list">
      <legend>{network ? `Network “${network}”` : 'Channels'} ({list.length})</legend>
      {list.length ? list.map((channel) => {
        const target = targets[channel.id];
        const plan = simulcastPlans.find((item) => item.target.channel.id === channel.id);
        return (
          <label key={channel.id} className="check-toggle">
            <input type="checkbox" checked={picked.includes(channel.id)} onChange={(event) => setPicked((current) => (event.target.checked ? [...current, channel.id] : current.filter((id) => id !== channel.id)))} />
            {label(channel)}
            {mode === 'simulcast' && picked.includes(channel.id) && <small>{!target ? ' · reading…' : 'error' in target ? ` · ${target.error}` : plan ? ` · from ${when(plan.placement.start)}${plan.placement.drift ? ` (${durationTimecode(Math.abs(plan.placement.drift))} late: a program there ends then)` : ''}${plan.target.generated ? ' · has a slot schedule' : ''}` : ' · empty lineup'}</small>}
            {drafts[channel.id] && <small> · has unsaved work in the desk, which this makes stale</small>}
          </label>
        );
      }) : <p className="hint">No other channel shares this channel’s group title. Channels form a network when they have the same group title (Channel Settings → General).</p>}
    </fieldset>
  );

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal network-modal" role="dialog" aria-modal="true" aria-labelledby="network-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">{label(source).toUpperCase()}</p>
        <h2 id="network-title">{MODE_TITLES[mode]}</h2>
        {mode !== 'commercials' && <p className="subtle">{block.items.length === 1 ? `“${programTitle(block.items[0], programs)}”` : `${block.items.length} items from “${block.items[0] ? programTitle(block.items[0], programs) : ''}”`} · {durationTimecode(length)}{block.start ? ` · airs ${when(block.start)} here` : ''}</p>}

        {mode === 'copy' && <>
          <div className="settings-grid">
            <label className="field"><span>To channel</span><select aria-label="Target channel" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {others.map((channel) => <option key={channel.id} value={channel.id}>{label(channel)}</option>)}
            </select></label>
            <label className="field"><span>Where</span><select aria-label="Where to copy" value={where} onChange={(event) => setWhere(event.target.value as Where)}>
              <option value="time">At a date and time</option>
              <option value="start">At the start of its lineup</option>
              <option value="end">At the end of its lineup</option>
            </select></label>
            {where === 'time' && <>
              <label className="field"><span>Date</span><input type="date" aria-label="Copy date" value={day} onChange={(event) => setDay(event.target.value)} /></label>
              <label className="field"><span>Time</span><input type="time" aria-label="Copy time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
            </>}
          </div>
          <div className="event-preview" role="status" aria-label="Copy preview">
            {!copyTarget ? <span>Reading the channel…</span> : 'error' in copyTarget ? <b className="slot-problem">{copyTarget.error}</b> : <>
              <b>{copyPlan?.start ? `Starts ${when(copyPlan.start)} on ${label(copyTarget.channel)}` : `Goes to position #${(copyPlan?.index ?? 0) + 1} of ${label(copyTarget.channel)}`}.</b>
              <span>Its lineup gets {durationTimecode(length)} longer, so its later programs (and repeats) move that much later. The copy repeats with its lineup.</span>
              {copyTarget.generated && <span>It has a slot schedule: Tunarr keeps the schedule, and regenerating it removes the copy.</span>}
              {redirectsToTarget && <b className="slot-problem">The selection redirects to that channel, which would point it at itself.</b>}
            </>}
          </div>
        </>}

        {mode === 'simulcast' && <>
          <p className="subtle">Each channel picked gets a redirect to this channel for {durationTimecode(length)}{block.start ? ` from ${when(block.start)}` : ''}, replacing what it would air (later programs keep their times). Tunarr can’t cut a program short, so a channel joins when its program on air ends.</p>
          {block.start === null && <p className="slot-problem">Pick the block on a day first, so it has a time.</p>}
          {pickList(inNetwork)}
        </>}

        {mode === 'commercials' && <>
          <p className="subtle">Gives each picked channel this channel’s commercial settings: the filler lists Tunarr plays in flex time (with weights and cooldowns), the repeat cooldown and the watermark setting. Lineups aren’t touched. Station IDs named for a channel still air only on it.</p>
          {pickList(inNetwork)}
        </>}

        {results.length > 0 && <ul className="network-results" aria-label="Results">
          {results.map((result) => <li key={result.id} className={result.ok ? 'ok' : 'failed'}><b>{result.label}</b> {result.message}</li>)}
        </ul>}

        <div className="dialog-actions">
          <button onClick={onClose}>{results.length ? 'Close' : 'Cancel'}</button>
          <button className="primary" disabled={busy || (mode === 'copy' ? !copyPlan || redirectsToTarget : mode === 'simulcast' ? !simulcastPlans.length : !picked.length)} onClick={() => void run()}>
            {busy ? 'Saving…' : mode === 'copy' ? 'Copy and save' : mode === 'simulcast' ? `Simulcast on ${simulcastPlans.length} ${simulcastPlans.length === 1 ? 'channel' : 'channels'}` : `Apply to ${picked.length} ${picked.length === 1 ? 'channel' : 'channels'}`}
          </button>
        </div>
      </section>
    </div>
  );
}
