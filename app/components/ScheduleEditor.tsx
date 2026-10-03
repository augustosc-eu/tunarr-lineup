'use client';

import { useMemo } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import {
  changeSlotSource,
  clockToOffset,
  DAY_MS,
  duplicateSlot,
  offsetToClock,
  ORDER_LABELS,
  periodMs,
  shiftTimeSlots,
  slotLabel,
  slotProblems,
  slotSourceKey,
  slotWeightShare,
  sortTimeSlots,
  sourceOptions,
  type Slot,
  type SlotSchedule,
} from '../../lib/schedule';

type Props = {
  channelLabel: string;
  schedule: SlotSchedule;
  slots: Slot[];
  busy: boolean;
  error: string;
  changed: boolean;
  previewReady: boolean;
  onChange: (slots: Slot[]) => void;
  onPreview: () => void;
  onSave: () => void;
  onRevert: () => void;
  onClose: () => void;
};

const MINUTE = 60_000;
const minutes = (ms: unknown) => (Number.isFinite(Number(ms)) ? String(Math.round((Number(ms) / MINUTE) * 100) / 100) : '');

function summary(schedule: SlotSchedule, count: number) {
  const parts = [schedule.type === 'time' ? `Time slots, repeating every ${schedule.period === 'week' ? 'week' : 'day'}` : `Random slots (${schedule.randomDistribution ?? 'weighted'})`];
  parts.push(`${count} ${count === 1 ? 'slot' : 'slots'}`);
  if (typeof schedule.maxDays === 'number') parts.push(`generates ${schedule.maxDays} ${schedule.maxDays === 1 ? 'day' : 'days'}`);
  if (typeof schedule.padMs === 'number' && schedule.padMs > 1) parts.push(`pads to ${durationTimecode(schedule.padMs)}`);
  if (schedule.flexPreference) parts.push(`flex at ${schedule.flexPreference === 'end' ? 'slot end' : 'distributed'}`);
  return parts.join(' · ');
}

export function ScheduleEditor({ channelLabel, schedule, slots, busy, error, changed, previewReady, onChange, onPreview, onSave, onRevert, onClose }: Props) {
  const options = useMemo(() => sourceOptions(schedule.slots), [schedule.slots]);
  const problems = slotProblems(schedule, slots);
  const valid = problems.every((problem) => !problem) && slots.length > 0;
  const time = schedule.type === 'time';
  // With uniform distribution Tunarr picks slots evenly and ignores weights.
  const weighted = schedule.randomDistribution !== 'uniform';
  const week = time && schedule.period === 'week';

  const update = (index: number, patch: Partial<Slot> | ((slot: Slot) => Slot)) => {
    const next = slots.map((slot, i) => (i === index ? (typeof patch === 'function' ? patch(slot) : { ...slot, ...patch }) : slot));
    onChange(time ? sortTimeSlots(next) : next);
  };
  const remove = (index: number) => onChange(slots.filter((_, i) => i !== index));
  const duplicate = (index: number) => {
    const copy = duplicateSlot(slots[index]);
    if (time) {
      const taken = new Set(slots.map((slot) => Number(slot.startTime)));
      let start = Number(copy.startTime) + 30 * MINUTE;
      while (taken.has(start % periodMs(schedule))) start += MINUTE;
      copy.startTime = start % periodMs(schedule);
      onChange(sortTimeSlots([...slots, copy]));
    } else {
      onChange([...slots.slice(0, index + 1), copy, ...slots.slice(index + 1)]);
    }
  };
  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= slots.length) return;
    const next = [...slots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SLOT SCHEDULE</p>
        <h2 id="schedule-title">Slot schedule · {channelLabel}</h2>
        <p className="subtle">{summary(schedule, slots.length)}</p>
        <p className="subtle">Tunarr builds this channel’s lineup from these slots, drawing programs from each slot’s show, collection or list. Only sources this schedule already uses are offered, so no new shows or collections are added. Preview to see the regenerated lineup, then save it with the same random seed.</p>

        {!time && !weighted && <p className="subtle">This schedule picks slots uniformly, so Tunarr ignores weights. They are kept as they are.</p>}
        {time && <div className="slot-tools" role="group" aria-label="Shift every slot">
          <span>Shift every slot</span>
          {[-15, -5, 5, 15].map((delta) => <button key={delta} disabled={busy} onClick={() => onChange(shiftTimeSlots(slots, delta * MINUTE, periodMs(schedule)))}>{delta > 0 ? '+' : '−'}{Math.abs(delta)} min</button>)}
        </div>}

        <div className="slot-table" role="table" aria-label="Slots">
          <div className={`slot-row slot-head ${time ? 'time' : 'random'}`} role="row">
            {time ? <><span role="columnheader">Starts</span><span role="columnheader">Plays</span><span role="columnheader">Order</span><span role="columnheader" /></>
              : <><span role="columnheader">#</span><span role="columnheader">Plays</span><span role="columnheader">Weight</span><span role="columnheader">Cooldown</span><span role="columnheader">Length</span><span role="columnheader">Order</span><span role="columnheader" /></>}
          </div>
          {slots.map((slot, index) => {
            const key = slotSourceKey(slot) ?? 'flex';
            const label = slotLabel(slot);
            const spec = (slot.durationSpec as { type?: string; programCount?: number; durationMs?: number } | undefined) ?? { type: 'dynamic', programCount: 1 };
            const hasOrder = typeof slot.order === 'string' && slot.order in ORDER_LABELS;
            const sourceSelect = (
              <select aria-label={`Slot ${index + 1} source`} value={key} disabled={busy} onChange={(event) => {
                const option = options.find((item) => item.key === event.target.value);
                if (option) update(index, (current) => changeSlotSource(current, option));
              }}>
                {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            );
            const orderSelect = hasOrder
              ? <select aria-label={`Slot ${index + 1} order`} value={String(slot.order)} disabled={busy} onChange={(event) => update(index, { order: event.target.value })}>{Object.entries(ORDER_LABELS).map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select>
              : <span className="subtle">—</span>;
            const actions = (
              <span className="slot-actions">
                {!time && <><button aria-label={`Move slot ${index + 1} up`} disabled={busy || index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move slot ${index + 1} down`} disabled={busy || index === slots.length - 1} onClick={() => move(index, 1)}>↓</button></>}
                <button aria-label={`Duplicate slot ${index + 1}`} disabled={busy} onClick={() => duplicate(index)}>Duplicate</button>
                <button aria-label={`Remove slot ${index + 1}`} disabled={busy || slots.length === 1} onClick={() => remove(index)}>Remove</button>
              </span>
            );
            return (
              <div key={`${slot.id ?? 'slot'}-${index}`} className={`slot-row ${time ? 'time' : 'random'} ${problems[index] ? 'invalid' : ''}`} role="row" title={label}>
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
                  <span className="slot-weight"><input type="number" min={0} step={0.5} aria-label={`Slot ${index + 1} weight`} value={String(slot.weight ?? '')} disabled={busy} onChange={(event) => update(index, { weight: event.target.value === '' ? Number.NaN : Number(event.target.value) })} /><small>{weighted ? `${slotWeightShare(slots, index).toFixed(1)}%` : 'equal'}</small></span>
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
                {problems[index] && <small className="slot-problem" role="alert">{problems[index]}</small>}
              </div>
            );
          })}
        </div>

        {error && <div className="warning" role="alert"><b>Tunarr didn’t accept this schedule</b><span>{error}</span></div>}
        <div className="dialog-actions schedule-actions">
          <button disabled={busy || !changed} onClick={onRevert}>Revert to saved</button>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !valid} onClick={onPreview}>{busy ? 'Working…' : 'Preview lineup'}</button>
          <button className="primary" disabled={busy || !valid || !previewReady} onClick={onSave} title={previewReady ? undefined : 'Preview first, so the save uses the lineup you saw.'}>Save schedule</button>
        </div>
      </section>
    </div>
  );
}
