'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { LibraryBrowser, type LibraryPick } from './LibraryBrowser';
import { dpadKey, keepFocusIn } from '../dpad';
import { durationLabel } from '../../lib/batch';
import { browserZone, inZone, zoneChoices } from '../../lib/calendar';
import type { Channel } from '../../lib/lineup';
import type { ListSummary } from '../../lib/library';
import { MAX_PLAN_DAYS, newSeed, planSaveBlocked, planSchedule, plannerProgram, type Daypart, type Plan, type PlannerSettings, type PlannerSource, type PlayOrder, type SourceRule } from '../../lib/planner';
import { tunarrApi, TunarrApiError } from '../../lib/tunarrClient';

type Props = {
  channel: Channel;
  /** The programming version the desk loaded; the save replaces exactly that. */
  version: string;
  /** The desk has unsaved edits (a plan replaces the whole lineup, so they'd be lost). */
  dirty: boolean;
  /** The channel runs on a slot schedule (a manual lineup would detach it). */
  generated: boolean;
  onSaved: (message: string) => void;
  onClose: () => void;
};

type Row = SourceRule & { label: string };
const toRule = ({ sourceId, weight, order, start, maxRepeats, cooldownMs }: Row): SourceRule => ({ sourceId, weight, order, start, maxRepeats, cooldownMs });
const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const errorText = (error: unknown) => (error instanceof TunarrApiError && error.code === 'lineup_changed' ? 'The channel changed in Tunarr while this was open. Close the planner, reload the channel and plan again.' : error instanceof Error ? error.message : 'Something went wrong.');
const ORDER_LABELS: Record<PlayOrder, string> = { episode: 'Episode order', 'season-block': 'A whole season at a time', shuffle: 'Shuffled (by the seed)' };
const pad = (value: number) => String(value).padStart(2, '0');
const localInput = (ms: number) => { const date = new Date(ms); return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: `${pad(date.getHours())}:${pad(date.getMinutes())}` }; };
const MAX_SHOWN_AIRINGS = 300;

/**
 * Edit → Advanced Planner…: rotations between shows, custom shows and picked
 * programs, worked out into a fixed lineup (lib/planner.ts). Preview shows
 * exactly what Save sends: nothing is regenerated, and the seed is in the
 * label. A plan doesn't follow the library afterwards.
 */
export function PlannerDialog({ channel, version, dirty, generated, onSaved, onClose }: Props) {
  const [sources, setSources] = useState<PlannerSource[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [customShows, setCustomShows] = useState<ListSummary[]>([]);
  const [picker, setPicker] = useState<'show' | 'programs' | null>(null);
  const [balance, setBalance] = useState<PlannerSettings['balance']>('duration');
  const [dayparts, setDayparts] = useState<Daypart[]>([]);
  const [start, setStart] = useState(() => localInput(Math.ceil(Date.now() / 3_600_000) * 3_600_000));
  const [days, setDays] = useState(7);
  const [timeZone, setTimeZone] = useState(browserZone());
  const [seed, setSeed] = useState(() => newSeed());
  const [plan, setPlan] = useState<Plan | null>(null);
  const [plannedWith, setPlannedWith] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [libraryName, setLibraryName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    tunarrApi.customShows().then(setCustomShows).catch(() => {});
    sectionRef.current?.querySelector<HTMLButtonElement>('button.planner-first')?.focus();
  }, []);

  const settings: PlannerSettings = {
    seed, days, balance, timeZone, dayparts,
    start: new Date(`${start.date}T${start.time}:00`).getTime(),
    rules: rows.map(toRule),
  };
  const key = JSON.stringify([settings, sources.map((source) => [source.id, source.programs.map((program) => program.id)])]);
  const stale = !!plan && key !== plannedWith;

  const run = async (work: () => Promise<void>) => {
    const previous = document.activeElement;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
      window.setTimeout(() => keepFocusIn(sectionRef.current, previous), 0);
    }
  };

  const addSource = (source: PlannerSource) => {
    if (!source.programs.length) return setError(`“${source.label}” has no programs to plan with.`);
    const id = `${source.id}-${sources.length}`;
    setSources((current) => [...current, { ...source, id }]);
    setRows((current) => [...current, { sourceId: id, label: source.label, weight: 1, order: 'episode', start: null, maxRepeats: null, cooldownMs: 0 }]);
  };

  const pick = (choice: LibraryPick) => run(async () => {
    setPicker(null);
    if ('show' in choice) {
      const episodes = await tunarrApi.descendants(choice.show.id);
      addSource({ id: choice.show.id, label: choice.show.title, programs: episodes.map((entry) => plannerProgram(entry)) });
    } else {
      addSource({ id: 'picked', label: choice.programs.length === 1 ? String((choice.programs[0].program as { title?: unknown }).title ?? 'A program') : `${choice.programs.length} picked programs`, programs: choice.programs.map((entry) => plannerProgram(entry)) });
    }
  });

  const addCustomShow = (id: string) => run(async () => {
    const show = customShows.find((item) => item.id === id);
    if (!show) return;
    const programs = await tunarrApi.customShowPrograms(id);
    addSource({ id, label: show.name, programs: programs.map((entry) => plannerProgram(entry)) });
  });

  const update = (sourceId: string, change: Partial<Row>) => setRows((current) => current.map((row) => (row.sourceId === sourceId ? { ...row, ...change } : row)));
  const remove = (sourceId: string) => {
    setRows((current) => current.filter((row) => row.sourceId !== sourceId));
    setSources((current) => current.filter((source) => source.id !== sourceId));
    setDayparts((current) => current.map((part) => { const weights = { ...part.weights }; delete weights[sourceId]; return { ...part, weights }; }));
  };
  const setPart = (id: string, change: Partial<Daypart>) => setDayparts((current) => current.map((part) => (part.id === id ? { ...part, ...change } : part)));

  const preview = () => {
    setError('');
    if (!rows.length) return setError('Add at least one show, custom show or set of programs.');
    if (!Number.isFinite(settings.start)) return setError('Choose when the plan starts.');
    setPlan(planSchedule(sources, settings));
    setPlannedWith(key);
    setConfirming(false);
  };

  /** A plan cut short by the planner's limit is never saved (it would look like the whole range). */
  const blocked = plan ? planSaveBlocked(plan, timeZone) : null;

  const save = () => run(async () => {
    if (!plan || stale) throw new Error('Preview the plan again first.');
    if (blocked) throw new Error(blocked);
    const saved = await tunarrApi.saveProgramming(channel.id, { type: 'manual', lineup: plan.items as never, append: false, startTime: plan.start }, version);
    const startTimeError = (saved as { startTimeError?: string }).startTimeError;
    onSaved(`Saved the plan (seed ${plan.seed}) to CH ${channel.number}: ${plan.items.length} items from ${inZone(plan.start, timeZone)}.${startTimeError ? ` ${startTimeError}` : ''}`);
  });

  const saveToLibrary = () => run(async () => {
    if (!plan || stale) throw new Error('Preview the plan again first.');
    if (blocked) throw new Error(blocked);
    const saved = await tunarrApi.saveToLibrary({ name: libraryName.trim() || `Plan ${plan.seed}`, description: `${days} day${days === 1 ? '' : 's'} from the planner, seed ${plan.seed}.`, tags: ['planner'], origin: { kind: 'planner', channelName: `CH ${channel.number} ${channel.name}` }, lineup: plan.items });
    setNotice(`Saved “${saved.name}” to the schedule library. Put it on a date from File → Schedule Library & Calendar.`);
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (back(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (picker) setPicker(null);
      else if (confirming) setConfirming(false);
      else onClose();
      return;
    }
    if (!picker) dpadKey(event, sectionRef.current);
  };

  const shown = useMemo(() => plan?.airings.slice(0, MAX_SHOWN_AIRINGS) ?? [], [plan]);
  const labelOf = (sourceId: string | null) => rows.find((row) => row.sourceId === sourceId)?.label ?? 'Flex time';

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} className="modal planner-modal" role="dialog" aria-modal="true" aria-labelledby="planner-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="planner-title">Advanced planner</h2>
        <p className="subtle">A plan is a fixed lineup worked out now: it won’t change by itself when the library changes. Plan again to include new episodes.</p>

        <h3 className="section-title">Sources</h3>
        <div className="batch-quick">
          <button className="planner-first" onClick={() => setPicker('show')}>Add a show…</button>
          <button onClick={() => setPicker('programs')}>Add programs…</button>
          <label className="field"><span>Add a custom show</span><select aria-label="Add a custom show" value="" onChange={(event) => { if (event.target.value) void addCustomShow(event.target.value); }}>
            <option value="">Choose…</option>{customShows.map((show) => <option key={show.id} value={show.id}>{show.name}</option>)}
          </select></label>
        </div>
        {!rows.length && <p className="issue-empty">No sources yet.</p>}
        {rows.map((row) => {
          const source = sources.find((item) => item.id === row.sourceId)!;
          return (
            <fieldset key={row.sourceId} className="pick-lists planner-source">
              <legend>{row.label} · {source.programs.length} programs · {durationLabel(source.programs.reduce((sum, program) => sum + program.duration, 0))}</legend>
              <label className="field"><span>Weight</span><input type="number" min={0} step={0.5} aria-label={`Weight of ${row.label}`} value={row.weight} onChange={(event) => update(row.sourceId, { weight: Math.max(0, Number(event.target.value) || 0) })} /></label>
              <label className="field"><span>Order</span><select aria-label={`Order of ${row.label}`} value={row.order} onChange={(event) => update(row.sourceId, { order: event.target.value as PlayOrder })}>{(Object.keys(ORDER_LABELS) as PlayOrder[]).map((order) => <option key={order} value={order}>{ORDER_LABELS[order]}</option>)}</select></label>
              {row.order !== 'shuffle' && <>
                <label className="field"><span>From season (empty: S01E01)</span><input type="number" min={0} aria-label={`Start season of ${row.label}`} value={row.start?.season ?? ''} onChange={(event) => update(row.sourceId, { start: event.target.value === '' ? null : { season: Number(event.target.value), episode: row.start?.episode ?? 1 } })} /></label>
                <label className="field"><span>episode</span><input type="number" min={1} aria-label={`Start episode of ${row.label}`} value={row.start?.episode ?? ''} disabled={!row.start} onChange={(event) => update(row.sourceId, { start: { season: row.start?.season ?? 1, episode: Math.max(1, Number(event.target.value) || 1) } })} /></label>
              </>}
              <label className="field"><span>Airs at most (empty: no limit)</span><input type="number" min={1} aria-label={`Repeat limit of ${row.label}`} value={row.maxRepeats ?? ''} onChange={(event) => update(row.sourceId, { maxRepeats: event.target.value === '' ? null : Math.max(1, Math.round(Number(event.target.value))) })} /></label>
              <label className="field"><span>Hours before a repeat</span><input type="number" min={0} step={0.5} aria-label={`Cooldown of ${row.label} in hours`} value={row.cooldownMs / 3_600_000} onChange={(event) => update(row.sourceId, { cooldownMs: Math.max(0, Number(event.target.value) || 0) * 3_600_000 })} /></label>
              <button onClick={() => remove(row.sourceId)}>Remove</button>
            </fieldset>
          );
        })}

        <fieldset className="pick-lists batch-tasks"><legend>Weights share out</legend>
          <label className="check-toggle"><input type="radio" name="planner-balance" checked={balance === 'duration'} onChange={() => setBalance('duration')} /> Airtime (a weight of 2 gets twice the hours)</label>
          <label className="check-toggle"><input type="radio" name="planner-balance" checked={balance === 'count'} onChange={() => setBalance('count')} /> Programs (a weight of 2 gets twice the airings, whatever their length)</label>
        </fieldset>

        <h3 className="section-title">Dayparts</h3>
        <p className="subtle">Parts of the day (or of weekdays or weekends) with their own weights, read in the plan’s time zone. A weight of 0 keeps a source out; the first daypart that matches wins.</p>
        {dayparts.map((part) => (
          <fieldset key={part.id} className="pick-lists planner-source">
            <legend>{part.label || 'Daypart'}</legend>
            <label className="field"><span>Name</span><input aria-label="Daypart name" value={part.label} onChange={(event) => setPart(part.id, { label: event.target.value })} /></label>
            <label className="field"><span>From</span><input type="time" aria-label={`${part.label} from`} value={part.from} onChange={(event) => setPart(part.id, { from: event.target.value })} /></label>
            <label className="field"><span>To</span><input type="time" aria-label={`${part.label} to`} value={part.to} onChange={(event) => setPart(part.id, { to: event.target.value })} /></label>
            <label className="field"><span>Days</span><select aria-label={`${part.label} days`} value={part.days} onChange={(event) => setPart(part.id, { days: event.target.value as Daypart['days'] })}><option value="all">Every day</option><option value="weekdays">Weekdays</option><option value="weekend">Weekends</option></select></label>
            {rows.map((row) => <label key={row.sourceId} className="field"><span>{row.label}</span><input type="number" min={0} step={0.5} aria-label={`${row.label} weight in ${part.label}`} value={part.weights[row.sourceId] ?? 0} onChange={(event) => setPart(part.id, { weights: { ...part.weights, [row.sourceId]: Math.max(0, Number(event.target.value) || 0) } })} /></label>)}
            <button onClick={() => setDayparts((current) => current.filter((item) => item.id !== part.id))}>Remove daypart</button>
          </fieldset>
        ))}
        <button onClick={() => setDayparts((current) => [...current, { id: `part-${Date.now()}`, label: `Daypart ${current.length + 1}`, from: '06:00', to: '12:00', days: 'all', weights: Object.fromEntries(rows.map((row) => [row.sourceId, row.weight])) }])}>Add a daypart</button>

        <h3 className="section-title">Plan</h3>
        <div className="batch-options">
          <label className="field"><span>Starts on (your local time)</span><input type="date" aria-label="Plan start date" value={start.date} onChange={(event) => setStart({ ...start, date: event.target.value })} /></label>
          <label className="field"><span>at</span><input type="time" aria-label="Plan start time" value={start.time} onChange={(event) => setStart({ ...start, time: event.target.value })} /></label>
          <label className="field"><span>Days (1–{MAX_PLAN_DAYS})</span><input type="number" min={1} max={MAX_PLAN_DAYS} aria-label="Days to plan" value={days} onChange={(event) => setDays(Math.min(MAX_PLAN_DAYS, Math.max(1, Math.round(Number(event.target.value) || 1))))} /></label>
          <label className="field"><span>Time zone (dayparts)</span><select aria-label="Plan time zone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>{zoneChoices(timeZone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label className="field"><span>Seed</span><span className="setup-row"><input aria-label="Seed" value={seed} maxLength={40} onChange={(event) => setSeed(event.target.value)} /><button onClick={() => setSeed(newSeed())}>New seed</button></span></label>
        </div>
        <div className="dialog-actions">
          <button className="primary" onClick={preview}>{plan ? 'Preview again' : 'Preview'}</button>
        </div>

        {plan && <div className="planner-preview" aria-live="polite">
          <h3 className="section-title">Preview · seed {plan.seed} {stale && <small>(out of date: preview again)</small>}</h3>
          <table className="planner-summary" aria-label="Distribution">
            <thead><tr><th>Source</th><th>Airings</th><th>Airtime</th><th>Share</th><th>Weight share</th></tr></thead>
            <tbody>{plan.summary.sources.map((share) => <tr key={share.sourceId}><td>{share.label}</td><td>{share.count}</td><td>{durationLabel(share.duration)}</td><td>{Math.round(share.share * 100)}% {balance === 'duration' ? 'of airtime' : 'of airings'}</td><td>{Math.round(share.target * 100)}%</td></tr>)}</tbody>
          </table>
          <p className="subtle">By genre: {plan.summary.genres.slice(0, 6).map((genre) => `${genre.name} ${durationLabel(genre.duration)}`).join(' · ') || '—'}. By type: {plan.summary.types.map((type) => `${type.name} ${durationLabel(type.duration)}`).join(' · ')}.</p>
          {blocked && <div className="warning" role="alert"><b>This plan is incomplete and can’t be saved</b><span>{blocked}</span></div>}
          {plan.warnings.filter((warning) => warning !== blocked).map((warning) => <div key={warning} className="warning" role="note"><span>{warning}</span></div>)}
          <ol className="planner-airings" aria-label="Planned airings">
            {shown.map((airing) => <li key={airing.start}><time>{inZone(airing.start, timeZone)}</time> <b>{airing.title}</b> <small>{labelOf(airing.sourceId)} · {durationLabel(airing.stop - airing.start)}</small></li>)}
            {plan.airings.length > shown.length && <li><small>…and {plan.airings.length - shown.length} more, until {inZone(plan.airings.at(-1)!.stop, timeZone)}.</small></li>}
          </ol>
          {confirming && <div className="warning" role="alert">
            <b>Replace CH {channel.number}’s whole lineup with this plan?</b>
            <span>{plan.items.length} items from {inZone(plan.start, timeZone)}; the channel’s start time moves there. A snapshot is kept first, and the save is refused if the channel changed since the desk loaded it.</span>
          </div>}
          {(dirty || generated) && <p className="slot-problem">{generated ? 'This channel runs on a slot schedule: a planned lineup would detach it. Save the plan to the schedule library instead, or plan for a manual channel.' : 'The desk has unsaved edits on this channel. Save or revert them first: the plan replaces the whole lineup.'}</p>}
          <div className="dialog-actions">
            <label className="field"><span>Library name</span><input aria-label="Name in the schedule library" value={libraryName} placeholder={`Plan ${plan.seed}`} onChange={(event) => setLibraryName(event.target.value)} /></label>
            <button disabled={busy || stale || !!blocked} onClick={() => void saveToLibrary()}>Save to the schedule library</button>
            {confirming
              ? <button className="primary" disabled={busy || stale || dirty || generated || !!blocked} onClick={() => void save()}>{busy ? 'Saving…' : `Replace and save to CH ${channel.number}`}</button>
              : <button className="primary" disabled={busy || stale || dirty || generated || !!blocked} onClick={() => setConfirming(true)}>Save to CH {channel.number}…</button>}
          </div>
        </div>}

        {notice && <p className="subtle" role="status">{notice}</p>}
        {error && <div className="warning" role="alert"><b>Not done</b><span>{error}</span></div>}
        <p className="hint">↑ ↓ move · OK picks · Back steps back, then closes</p>
        {picker && <LibraryBrowser title={picker === 'show' ? 'Add a show to the plan' : 'Add programs to the plan'} mode={picker === 'show' ? 'show' : 'programs'} confirmLabel="Add" onPick={(choice) => void pick(choice)} onClose={() => setPicker(null)} />}
      </section>
    </div>
  );
}
