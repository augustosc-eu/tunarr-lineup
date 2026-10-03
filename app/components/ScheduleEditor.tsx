'use client';

import { useMemo, useState } from 'react';
import {
  catalogOptions,
  changeSlotSource,
  clockToOffset,
  commercialSummary,
  convertDraft,
  DAY_MS,
  DEFAULT_MID_ROLL,
  duplicateSlot,
  FILLER_ORDER_LABELS,
  FILLER_POSITIONS,
  LATENESS_OPTIONS,
  newSlot,
  offsetToClock,
  ORDER_LABELS,
  PAD_OPTIONS,
  periodMs,
  shiftTimeSlots,
  slotCanHaveCommercials,
  slotLabel,
  slotProblems,
  slotSourceKey,
  slotWeightShare,
  sortTimeSlots,
  type MidRoll,
  type ScheduleDraftState,
  type Slot,
  type SlotCatalog,
  type SlotFiller,
} from '../../lib/schedule';

type Props = {
  channelLabel: string;
  isNew: boolean;
  draft: ScheduleDraftState;
  changed: boolean;
  catalog: SlotCatalog | null;
  currentChannelId: string;
  busy: boolean;
  error: string;
  previewReady: boolean;
  onChange: (draft: ScheduleDraftState) => void;
  /** Opens the library to pick a show, for slot `index` or a new slot (null). */
  onBrowseShow: (index: number | null) => void;
  onBrowseMovies: () => void;
  onPreview: () => void;
  onSave: () => void;
  onDetach?: () => void;
  onRevert: () => void;
  onClose: () => void;
};

const MINUTE = 60_000;
const minutes = (ms: unknown) => (Number.isFinite(Number(ms)) ? String(Math.round((Number(ms) / MINUTE) * 100) / 100) : '');
const LIBRARY_SHOW = '__library-show__';

function SlotCommercials({ slot, fillerLists, onChange }: { slot: Slot; fillerLists: Array<{ id: string; name: string }>; onChange: (slot: Slot) => void }) {
  const fillers = Array.isArray(slot.filler) ? (slot.filler as SlotFiller[]) : [];
  const midRoll = slot.midRoll as MidRoll | undefined;
  const setFillers = (next: SlotFiller[]) => {
    const updated: Slot = { ...slot, filler: next };
    if (!next.length) delete updated.filler;
    onChange(updated);
  };
  const setMidRoll = (next: MidRoll | undefined) => {
    const updated: Slot = { ...slot, midRoll: next };
    if (!next) delete updated.midRoll;
    onChange(updated);
  };
  const hasMidFiller = fillers.some((filler) => filler.types.includes('mid'));
  return (
    <div className="slot-commercials">
      {!fillerLists.length && <p className="subtle">Create a filler list first (Lists → Filler Lists…) to add commercials.</p>}
      {fillers.map((filler, index) => (
        <div className="commercial-row" key={index}>
          <select aria-label={`Commercial list ${index + 1}`} value={filler.fillerListId} onChange={(event) => setFillers(fillers.map((item, i) => (i === index ? { ...item, fillerListId: event.target.value } : item)))}>
            {fillerLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
            {!fillerLists.some((list) => list.id === filler.fillerListId) && <option value={filler.fillerListId}>Missing list</option>}
          </select>
          <span className="checklist inline" role="group" aria-label={`Where commercial list ${index + 1} plays`}>
            {FILLER_POSITIONS.map(([value, label]) => (
              <label key={value}><input type="checkbox" checked={filler.types.includes(value)} onChange={(event) => {
                const types = event.target.checked ? [...filler.types, value] : filler.types.filter((type) => type !== value);
                setFillers(fillers.map((item, i) => (i === index ? { ...item, types } : item)));
              }} /> {label}</label>
            ))}
          </span>
          <select aria-label={`Commercial list ${index + 1} order`} value={filler.fillerOrder ?? 'shuffle_prefer_short'} onChange={(event) => setFillers(fillers.map((item, i) => (i === index ? { ...item, fillerOrder: event.target.value } : item)))}>
            {Object.entries(FILLER_ORDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button aria-label={`Remove commercial list ${index + 1}`} onClick={() => setFillers(fillers.filter((_, i) => i !== index))}>Remove</button>
        </div>
      ))}
      <div className="commercial-tools">
        <button disabled={!fillerLists.length} onClick={() => setFillers([...fillers, { types: ['pre'], fillerListId: fillerLists[0].id, fillerOrder: 'shuffle_prefer_short' }])}>Add commercials</button>
        <label><input type="checkbox" checked={!!midRoll} onChange={(event) => setMidRoll(event.target.checked ? structuredClone(DEFAULT_MID_ROLL) : undefined)} /> Mid-roll breaks inside programs</label>
      </div>
      {midRoll && <div className="commercial-row">
        <label>Every <input type="number" min={1} step={1} aria-label="Break interval minutes" value={minutes(midRoll.breakRule?.intervalMs ?? midRoll.intervalMs)} onChange={(event) => setMidRoll({ ...midRoll, breakRule: { type: 'fixed_interval', intervalMs: Math.max(1, Number(event.target.value)) * MINUTE } })} /> min</label>
        <label>Break length <input type="number" min={0.5} step={0.5} aria-label="Break length minutes" value={minutes(midRoll.breakDurationMs)} onChange={(event) => setMidRoll({ ...midRoll, breakDurationMs: Math.max(0.5, Number(event.target.value)) * MINUTE })} /> min</label>
        <label>At most <input type="number" min={0} step={1} aria-label="Maximum breaks" value={midRoll.maxBreaks} onChange={(event) => setMidRoll({ ...midRoll, maxBreaks: Math.max(0, Math.round(Number(event.target.value))) })} /> breaks</label>
        <label>Only in programs over <input type="number" min={0} step={1} aria-label="Minimum program minutes" value={minutes(midRoll.minProgramDurationMs)} onChange={(event) => setMidRoll({ ...midRoll, minProgramDurationMs: Math.max(0, Number(event.target.value)) * MINUTE })} /> min</label>
        {!hasMidFiller && <small className="slot-problem">Tick “Mid-roll breaks” on a commercial list so the breaks have something to play.</small>}
      </div>}
    </div>
  );
}

function summary(draft: ScheduleDraftState) {
  const parts = [draft.type === 'time' ? `Time slots, repeating every ${draft.settings.period === 'week' ? 'week' : 'day'}` : `Random slots (${draft.settings.randomDistribution === 'none' ? 'in order' : draft.settings.randomDistribution ?? 'uniform'})`];
  parts.push(`${draft.slots.length} ${draft.slots.length === 1 ? 'slot' : 'slots'}`);
  if (typeof draft.settings.maxDays === 'number') parts.push(`generates ${draft.settings.maxDays} ${draft.settings.maxDays === 1 ? 'day' : 'days'}`);
  return parts.join(' · ');
}

export function ScheduleEditor(props: Props) {
  const { channelLabel, isNew, draft, changed, catalog, currentChannelId, busy, error, previewReady, onChange, onBrowseShow, onBrowseMovies, onPreview, onSave, onDetach, onRevert, onClose } = props;
  const [expanded, setExpanded] = useState<number | null>(null);
  const [adding, setAdding] = useState('');
  const options = useMemo(() => catalogOptions(draft.slots, catalog ?? { customShows: [], fillerLists: [], smartCollections: [], channels: [] }, currentChannelId), [catalog, currentChannelId, draft.slots]);
  const fillerNames = useMemo(() => new Map((catalog?.fillerLists ?? []).map((list) => [list.id, list.name])), [catalog]);
  const problems = slotProblems({ type: draft.type, period: draft.settings.period as 'day' | 'week' }, draft.slots);
  const valid = problems.every((problem) => !problem) && draft.slots.length > 0;
  const time = draft.type === 'time';
  const week = time && draft.settings.period === 'week';
  const period = periodMs({ type: draft.type, period: draft.settings.period as 'day' | 'week' });
  const weighted = draft.settings.randomDistribution === 'weighted';
  const hasMovieSlot = draft.slots.some((slot) => slot.type === 'movie');

  const setSlots = (slots: Slot[]) => onChange({ ...draft, slots: time ? sortTimeSlots(slots) : slots });
  const setSetting = (key: string, value: unknown) => onChange({ ...draft, settings: { ...draft.settings, [key]: value } });
  const update = (index: number, patch: Partial<Slot> | ((slot: Slot) => Slot)) => setSlots(draft.slots.map((slot, i) => (i === index ? (typeof patch === 'function' ? patch(slot) : { ...slot, ...patch }) : slot)));
  const remove = (index: number) => { setSlots(draft.slots.filter((_, i) => i !== index)); setExpanded(null); };
  const duplicate = (index: number) => {
    const copy = duplicateSlot(draft.slots[index]);
    if (time) {
      const taken = new Set(draft.slots.map((slot) => Number(slot.startTime)));
      let start = (Number(copy.startTime) + 30 * MINUTE) % period;
      while (taken.has(start)) start = (start + MINUTE) % period;
      copy.startTime = start;
      setSlots([...draft.slots, copy]);
    } else {
      setSlots([...draft.slots.slice(0, index + 1), copy, ...draft.slots.slice(index + 1)]);
    }
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.slots.length) return;
    const next = [...draft.slots];
    [next[index], next[target]] = [next[target], next[index]];
    setSlots(next);
  };
  const addSlot = (key: string) => {
    if (key === LIBRARY_SHOW) {
      onBrowseShow(null);
      return;
    }
    const option = options.find((item) => item.key === key);
    if (option) setSlots([...draft.slots, newSlot(draft, option)]);
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SLOT SCHEDULE</p>
        <h2 id="schedule-title">{isNew ? 'New slot schedule' : 'Slot schedule'} · {channelLabel}</h2>
        <p className="subtle">{summary(draft)}</p>

        <div className="schedule-settings">
          <div className="segmented" role="radiogroup" aria-label="Schedule type">
            <button role="radio" aria-checked={draft.type === 'random'} className={draft.type === 'random' ? 'primary' : ''} disabled={busy} onClick={() => onChange(convertDraft(draft, 'random'))}>Random slots</button>
            <button role="radio" aria-checked={draft.type === 'time'} className={draft.type === 'time' ? 'primary' : ''} disabled={busy} onClick={() => onChange(convertDraft(draft, 'time'))}>Time slots</button>
          </div>
          {time ? <>
            <label className="field"><span>Repeats</span><select value={String(draft.settings.period ?? 'day')} onChange={(event) => onChange({ ...draft, settings: { ...draft.settings, period: event.target.value }, slots: event.target.value === 'day' ? sortTimeSlots(draft.slots.map((slot) => ({ ...slot, startTime: Number(slot.startTime) % DAY_MS }))) : draft.slots })}><option value="day">Every day</option><option value="week">Every week</option></select></label>
            <label className="field"><span>Late start allowed</span><select value={String(draft.settings.latenessMs ?? 0)} onChange={(event) => setSetting('latenessMs', Number(event.target.value))}>{LATENESS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="field"><span>Running over</span><select value={(draft.settings.overflow as { type?: string; maxMs?: number } | undefined)?.type === 'oneExtra' ? 'oneExtra' : String((draft.settings.overflow as { maxMs?: number } | undefined)?.maxMs ?? 0)} onChange={(event) => setSetting('overflow', event.target.value === 'oneExtra' ? { type: 'oneExtra' } : { type: 'duration', maxMs: Number(event.target.value) })}>
              <option value="0">Stop at the next slot</option>{[5, 10, 15, 30, 60].map((value) => <option key={value} value={value * MINUTE}>Up to {value} min over</option>)}<option value="oneExtra">Finish one more program</option>
            </select></label>
          </> : <>
            <label className="field"><span>Pick slots</span><select value={String(draft.settings.randomDistribution ?? 'uniform')} onChange={(event) => setSetting('randomDistribution', event.target.value)}><option value="uniform">Evenly at random</option><option value="weighted">By weight</option><option value="none">In order</option></select></label>
            <label className="field"><span>Pad by</span><select value={String(draft.settings.padStyle ?? 'slot')} onChange={(event) => setSetting('padStyle', event.target.value)}><option value="slot">Slot</option><option value="episode">Episode</option></select></label>
          </>}
          <label className="field"><span>Start times</span><select value={String(draft.settings.padMs ?? 1)} onChange={(event) => setSetting('padMs', Number(event.target.value))}>
            {PAD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {!time && Number(draft.settings.padMs) === 0 && <option value="0">Do not pad</option>}
          </select></label>
          <label className="field"><span>Flex time goes</span><select value={String(draft.settings.flexPreference ?? 'distribute')} onChange={(event) => setSetting('flexPreference', event.target.value)}><option value="distribute">Between programs</option><option value="end">At the end of the slot</option></select></label>
          <label className="field"><span>Days to generate</span><input type="number" min={1} max={3650} step={1} value={Number(draft.settings.maxDays ?? 365)} onChange={(event) => setSetting('maxDays', Math.max(1, Math.min(3650, Math.round(Number(event.target.value)))))} /></label>
        </div>

        {time && <div className="slot-tools" role="group" aria-label="Shift every slot">
          <span>Shift every slot</span>
          {[-15, -5, 5, 15].map((delta) => <button key={delta} disabled={busy || !draft.slots.length} onClick={() => setSlots(shiftTimeSlots(draft.slots, delta * MINUTE, period))}>{delta > 0 ? '+' : '−'}{Math.abs(delta)} min</button>)}
        </div>}

        <div className="slot-table" role="table" aria-label="Slots">
          <div className={`slot-row slot-head ${time ? 'time' : 'random'}`} role="row">
            {time ? <><span role="columnheader">Starts</span><span role="columnheader">Plays</span><span role="columnheader">Order</span><span role="columnheader" /></>
              : <><span role="columnheader">#</span><span role="columnheader">Plays</span><span role="columnheader">Weight</span><span role="columnheader">Cooldown</span><span role="columnheader">Length</span><span role="columnheader">Order</span><span role="columnheader" /></>}
          </div>
          {!draft.slots.length && <p className="subtle candidate-empty">No slots yet. Add one below.</p>}
          {draft.slots.map((slot, index) => {
            const key = slotSourceKey(slot) ?? 'flex';
            const spec = (slot.durationSpec as { type?: string; programCount?: number; durationMs?: number } | undefined) ?? { type: 'dynamic', programCount: 1 };
            const hasOrder = typeof slot.order === 'string' && slot.order in ORDER_LABELS;
            const commercials = slotCanHaveCommercials(slot) ? commercialSummary(slot, fillerNames) : '';
            const sourceSelect = (
              <select aria-label={`Slot ${index + 1} source`} value={key} disabled={busy} onChange={(event) => {
                if (event.target.value === LIBRARY_SHOW) {
                  onBrowseShow(index);
                  return;
                }
                const option = options.find((item) => item.key === event.target.value);
                if (option) update(index, (current) => changeSlotSource(current, option));
              }}>
                {!options.some((option) => option.key === key) && <option value={key}>{slotLabel(slot)}</option>}
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                <option value={LIBRARY_SHOW}>Another show from the library…</option>
              </select>
            );
            const orderSelect = hasOrder
              ? <select aria-label={`Slot ${index + 1} order`} value={String(slot.order)} disabled={busy} onChange={(event) => update(index, { order: event.target.value })}>{Object.entries(ORDER_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>
              : <span className="subtle">—</span>;
            const actions = (
              <span className="slot-actions">
                {!time && <><button aria-label={`Move slot ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move slot ${index + 1} down`} disabled={busy || index === draft.slots.length - 1} onClick={() => move(index, 1)}>↓</button></>}
                {slotCanHaveCommercials(slot) && <button aria-expanded={expanded === index} aria-label={`Commercials for slot ${index + 1}`} onClick={() => setExpanded(expanded === index ? null : index)}>Ads{Array.isArray(slot.filler) || slot.midRoll ? ' ●' : ''}</button>}
                <button aria-label={`Duplicate slot ${index + 1}`} disabled={busy} onClick={() => duplicate(index)}>Copy</button>
                <button aria-label={`Remove slot ${index + 1}`} disabled={busy} onClick={() => remove(index)}>Remove</button>
              </span>
            );
            return (
              <div key={`${slot.id ?? 'slot'}-${index}`} className={`slot-row ${time ? 'time' : 'random'} ${problems[index] ? 'invalid' : ''}`} role="row">
                {time ? <>
                  <span className="slot-start">
                    {week && <select aria-label={`Slot ${index + 1} day`} value={Math.floor(Number(slot.startTime) / DAY_MS)} disabled={busy} onChange={(event) => update(index, { startTime: Number(event.target.value) * DAY_MS + (Number(slot.startTime) % DAY_MS) })}>
                      {Array.from({ length: 7 }, (_, day) => <option key={day} value={day}>Day {day + 1}</option>)}
                    </select>}
                    <input type="time" step="1" aria-label={`Slot ${index + 1} start`} value={offsetToClock(Number(slot.startTime))} disabled={busy} onChange={(event) => {
                      const offset = clockToOffset(event.target.value);
                      if (Number.isFinite(offset)) update(index, { startTime: (week ? Math.floor(Number(slot.startTime) / DAY_MS) * DAY_MS : 0) + offset });
                    }} />
                  </span>
                  {sourceSelect}{orderSelect}{actions}
                </> : <>
                  <span className="slot-index">{index + 1}</span>
                  {sourceSelect}
                  <span className="slot-weight"><input type="number" min={0} step={0.5} aria-label={`Slot ${index + 1} weight`} value={String(slot.weight ?? '')} disabled={busy} onChange={(event) => update(index, { weight: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /><small>{weighted ? `${slotWeightShare(draft.slots, index).toFixed(1)}%` : 'equal'}</small></span>
                  <span className="slot-number"><input type="number" min={0} step={1} aria-label={`Slot ${index + 1} cooldown minutes`} value={minutes(slot.cooldownMs)} disabled={busy} onChange={(event) => update(index, { cooldownMs: event.target.value === '' ? Number.NaN : Math.round(Number(event.target.value) * MINUTE) })} /><small>min</small></span>
                  <span className="slot-length">
                    <select aria-label={`Slot ${index + 1} length type`} value={spec.type === 'fixed' ? 'fixed' : 'dynamic'} disabled={busy} onChange={(event) => update(index, { durationSpec: event.target.value === 'fixed' ? { type: 'fixed', durationMs: 30 * MINUTE } : { type: 'dynamic', programCount: 1 } })}>
                      <option value="dynamic">Programs</option><option value="fixed">Minutes</option>
                    </select>
                    <input type="number" min={1} step={1} aria-label={`Slot ${index + 1} length`} disabled={busy}
                      value={spec.type === 'fixed' ? minutes(spec.durationMs) : String(spec.programCount ?? 1)}
                      onChange={(event) => update(index, { durationSpec: spec.type === 'fixed' ? { type: 'fixed', durationMs: Math.round(Number(event.target.value) * MINUTE) } : { type: 'dynamic', programCount: Number(event.target.value) } })} />
                  </span>
                  {orderSelect}{actions}
                </>}
                {commercials && expanded !== index && <small className="slot-note">Ads: {commercials}</small>}
                {problems[index] && <small className="slot-problem" role="alert">{problems[index]}</small>}
                {expanded === index && <SlotCommercials slot={slot} fillerLists={catalog?.fillerLists ?? []} onChange={(updated) => update(index, () => updated)} />}
              </div>
            );
          })}
        </div>

        <div className="slot-tools">
          <label className="field add-slot"><span>Add a slot that plays</span>
            <select aria-label="Add a slot" value={adding} disabled={busy || !catalog} onChange={(event) => { addSlot(event.target.value); setAdding(''); }}>
              <option value="">{catalog ? 'Choose…' : 'Loading sources…'}</option>
              <option value={LIBRARY_SHOW}>A show from the library…</option>
              {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
            </select>
          </label>
          {hasMovieSlot && <span className="movie-pool">Movie slots draw from this channel’s movies{draft.extraMovies.length ? ` plus ${draft.extraMovies.length} added` : ''}. <button onClick={onBrowseMovies}>Add movies…</button>{draft.extraMovies.length > 0 && <button onClick={() => onChange({ ...draft, extraMovies: [] })}>Clear added</button>}</span>}
        </div>
        {hasMovieSlot && draft.extraMovies.length > 0 && <p className="subtle">Added movies are included when you save; Tunarr’s preview only uses movies already on the channel.</p>}

        {error && <div className="warning" role="alert"><b>Tunarr didn’t accept this schedule</b><span>{error}</span></div>}
        <div className="dialog-actions schedule-actions">
          <button disabled={busy || !changed} onClick={onRevert}>Revert</button>
          {onDetach && <button disabled={busy} onClick={onDetach} title="Keep today’s lineup as a manual lineup and stop generating it from slots.">Detach to manual lineup</button>}
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !valid} onClick={onPreview}>{busy ? 'Working…' : 'Preview lineup'}</button>
          <button className="primary" disabled={busy || !valid || !previewReady} onClick={onSave} title={previewReady ? undefined : 'Preview first, so the save uses the lineup you saw.'}>Save schedule</button>
        </div>
      </section>
    </div>
  );
}
