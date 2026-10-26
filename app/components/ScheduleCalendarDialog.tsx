'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { dpadKey, keepFocusIn } from '../dpad';
import { blankForm, conflictLine, CONTINUE_UNSUPPORTED, END_LABELS, formToInput, inputToForm, inZone, MONTH_NAMES, recurrenceLabel, START_LABELS, WEEKDAY_NAMES, zoneChoices, type CalendarForm } from '../../lib/calendar';
import { durationLabel } from '../../lib/batch';
import type { Channel } from '../../lib/lineup';
import { tunarrApi, type CalendarEntryView } from '../../lib/tunarrClient';
import type { CalendarCheck } from '../../server/calendarArm';
import type { LibrarySummary } from '../../server/calendarStore';

/** A lineup to put in the library: the desk's edits, or a slot preview. */
export type LibraryDraft = { lineup: unknown[]; programs: Record<string, unknown>; origin: { kind: 'desk' | 'slot-preview'; channelName: string } };

type Props = {
  channels: Channel[];
  toSave: LibraryDraft | null;
  onClose: () => void;
};

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const ORIGIN_LABELS: Record<string, string> = { desk: 'From the desk', 'slot-preview': 'From a slot preview', package: 'From a package', snapshot: 'From a snapshot', planner: 'From the planner' };
const STATUS_LABELS: Record<string, string> = { armed: 'Planned', suppressed: 'Outranked', skipped: 'Skipped' };

/**
 * File → Schedule Library & Calendar…: lineups saved apart from any channel,
 * and the calendar that puts them on channels on dates (once, every year,
 * every week), each occurrence planned as an ordinary scheduled change shortly
 * before it starts. Conflicts are checked before an entry is saved.
 */
export function ScheduleCalendarDialog({ channels, toSave, onClose }: Props) {
  const sorted = useMemo(() => [...channels].sort((a, b) => a.number - b.number), [channels]);
  const label = useCallback((id: string) => { const channel = sorted.find((item) => item.id === id); return channel ? `CH ${channel.number} ${channel.name}` : 'a channel that’s gone'; }, [sorted]);
  const [tab, setTab] = useState<'library' | 'calendar'>(toSave ? 'library' : 'calendar');
  const [library, setLibrary] = useState<LibrarySummary[] | null>(null);
  const [calendar, setCalendar] = useState<{ enabled: boolean; message?: string; entries: CalendarEntryView[] } | null>(null);
  const [draft, setDraft] = useState({ name: '', description: '', tags: '' });
  const [form, setForm] = useState<CalendarForm | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [check, setCheck] = useState<CalendarCheck | null>(null);
  const [checkedWith, setCheckedWith] = useState('');
  const [exception, setException] = useState('');
  const [history, setHistory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sectionRef = useRef<HTMLElement>(null);

  const reload = useCallback(() => Promise.all([
    tunarrApi.scheduleLibrary().then(setLibrary),
    tunarrApi.calendar().then(setCalendar),
  ]).catch((reason) => setError(errorText(reason))), []);

  useEffect(() => {
    void reload();
    sectionRef.current?.querySelector<HTMLButtonElement>('.room-filters button[aria-pressed="true"]')?.focus();
  }, [reload]);

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
      // After the re-render that re-enables the buttons.
      window.setTimeout(() => keepFocusIn(sectionRef.current, previous), 0);
    }
  };

  const saveDraft = () => run(async () => {
    if (!toSave) return;
    const saved = await tunarrApi.saveToLibrary({ name: draft.name, description: draft.description, tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean), origin: toSave.origin, lineup: toSave.lineup, programs: toSave.programs });
    setNotice(`Saved “${saved.name}” to the library (${saved.items} items). Add it to the calendar to put it on a date.`);
    setDraft({ name: '', description: '', tags: '' });
    await reload();
  });

  const startForm = (scheduleId: string, entry?: CalendarEntryView) => {
    setTab('calendar');
    setForm(entry ? inputToForm(entry) : { ...blankForm(scheduleId, []), name: library?.find((item) => item.id === scheduleId)?.name ?? '' });
    setEditingId(entry?.id ?? null);
    setCheck(null);
    setCheckedWith('');
  };

  const input = form ? formToInput(form) : null;
  const stale = !!check && JSON.stringify(input) !== checkedWith;

  const runCheck = () => run(async () => {
    if (!input) return;
    const result = await tunarrApi.previewCalendar({ ...input, ...(editingId ? { id: editingId } : {}) });
    setCheck(result);
    setCheckedWith(JSON.stringify(input));
  });

  const saveEntry = () => run(async () => {
    if (!input || !check || stale || check.refused) return;
    const saved = editingId ? await tunarrApi.updateCalendarEntry(editingId, input) : await tunarrApi.createCalendarEntry(input);
    setNotice(`“${saved.name}” is on the calendar.${saved.next[0] ? ` Next: ${inZone(saved.next[0].start, saved.timeZone)}.` : ''}${editingId ? ' Occurrences that haven’t started are planned again; one on air now keeps its plan.' : ''}${saved.reconciled === false && saved.warning ? ` ${saved.warning}` : ''}`);
    setForm(null);
    setCheck(null);
    await reload();
  });

  const endNow = (entry: CalendarEntryView) => run(async () => {
    const result = await tunarrApi.endCalendarEntry(entry.id);
    setNotice(result.ending ? `Ending “${entry.name}” now: the old lineup goes back if nothing changed during it.${calendar?.enabled ? '' : ' Scheduled changes are off, so it waits until they’re on.'}` : `Nothing of “${entry.name}” is on now.`);
    await reload();
  });

  const remove = (entry: CalendarEntryView) => run(async () => {
    const result = await tunarrApi.deleteCalendarEntry(entry.id);
    setNotice(`Removed “${entry.name}”.${result.ending ? ' What it had on now is being put back.' : ''}${result.cancelled ? ` ${result.cancelled} planned occurrence${result.cancelled === 1 ? '' : 's'} cancelled.` : ''}${result.reconciled === false && result.warning ? ` ${result.warning}` : ''}`);
    await reload();
  });

  const removeSchedule = (item: LibrarySummary) => run(async () => {
    await tunarrApi.deleteLibraryEntry(item.id);
    setNotice(`Deleted “${item.name}” from the library.`);
    await reload();
  });

  const set = <K extends keyof CalendarForm>(key: K, value: CalendarForm[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const toggle = (list: number[] | string[], value: number | string) => ((list as Array<number | string>).includes(value) ? (list as Array<number | string>).filter((item) => item !== value) : [...list, value]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (back(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      if (form) setForm(null);
      else onClose();
      return;
    }
    dpadKey(event, sectionRef.current);
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} className="modal calendar-modal" role="dialog" aria-modal="true" aria-labelledby="calendar-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">PROGRAMMING</p>
        <h2 id="calendar-title">Schedule library & calendar</h2>
        <div className="room-filters" role="toolbar" aria-label="Views">
          <button aria-pressed={tab === 'library'} className={tab === 'library' ? 'primary' : ''} onClick={() => { setTab('library'); setForm(null); }}>Library ({library?.length ?? '…'})</button>
          <button aria-pressed={tab === 'calendar'} className={tab === 'calendar' ? 'primary' : ''} onClick={() => setTab('calendar')}>Calendar ({calendar?.entries.length ?? '…'})</button>
        </div>
        {calendar && !calendar.enabled && <div className="warning" role="note"><b>Scheduled changes are off</b><span>{calendar.message}</span></div>}

        {tab === 'library' && <>
          {toSave && <fieldset className="pick-lists calendar-save">
            <legend>Save this lineup ({toSave.lineup.length} items · {toSave.origin.kind === 'slot-preview' ? 'a slot preview' : 'the desk’s lineup'} of {toSave.origin.channelName})</legend>
            <label className="field"><span>Name</span><input aria-label="Schedule name" value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label className="field"><span>Description</span><input aria-label="Schedule description" value={draft.description} maxLength={1000} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
            <label className="field"><span>Tags (comma-separated)</span><input aria-label="Schedule tags" value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} /></label>
            <div className="dialog-actions"><button className="primary" disabled={busy || !draft.name.trim()} onClick={() => void saveDraft()}>Save to the library</button></div>
          </fieldset>}
          <ul className="issue-list" aria-label="Saved schedules">
            {!library && <li className="issue-empty">Loading…</li>}
            {library?.length === 0 && <li className="issue-empty">Nothing saved yet. Use File → Save to Schedule Library… on a channel, or a slot preview.</li>}
            {library?.map((item) => (
              <li key={item.id} className="calendar-row">
                <span><b>{item.name}</b><small>{item.items} items · {durationLabel(item.length)} a pass · {ORIGIN_LABELS[item.origin.kind]}{item.origin.channelName ? ` (${item.origin.channelName})` : ''}{item.tags.length ? ` · ${item.tags.join(', ')}` : ''}</small>{item.description && <small>{item.description}</small>}</span>
                <span className="calendar-actions">
                  <button onClick={() => startForm(item.id)}>Add to calendar…</button>
                  <button disabled={busy} onClick={() => void removeSchedule(item)}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </>}

        {tab === 'calendar' && !form && <>
          <ul className="issue-list" aria-label="Calendar entries">
            {!calendar && <li className="issue-empty">Loading…</li>}
            {calendar?.entries.length === 0 && <li className="issue-empty">No entries yet. Pick a saved schedule in the library and choose Add to calendar…</li>}
            {calendar?.entries.map((entry) => (
              <li key={entry.id} className="calendar-row">
                <span>
                  <b>{entry.name}{entry.active ? ' · ON NOW' : ''}{entry.enabled ? '' : ' · off'}</b>
                  <small>{entry.scheduleName ?? 'Its schedule was deleted'} · {entry.channelIds.map(label).join(', ')} · priority {entry.priority}</small>
                  <small>{recurrenceLabel(entry.recurrence)} ({entry.timeZone}){entry.exceptions.length ? ` · except ${entry.exceptions.join(', ')}` : ''}</small>
                  <small>{entry.next[0] ? `Next: ${inZone(entry.next[0].start, entry.timeZone)}${entry.next[0].end ? ` → ${inZone(entry.next[0].end, entry.timeZone)}` : ''}` : 'No more occurrences.'}</small>
                  {history === entry.id && <ul className="room-findings" aria-label={`History of ${entry.name}`}>
                    {entry.history.length ? entry.history.slice(0, 10).map((record) => <li key={record.key}><em className="issue-badge">{STATUS_LABELS[record.status]}</em><span><b>{label(record.channelId)} · {inZone(record.start, entry.timeZone)}</b><small>{record.message}</small></span></li>) : <li><span>Nothing has been planned from it yet.</span></li>}
                  </ul>}
                </span>
                <span className="calendar-actions">
                  <button onClick={() => startForm(entry.scheduleId, entry)}>Edit…</button>
                  <button aria-pressed={history === entry.id} onClick={() => setHistory(history === entry.id ? null : entry.id)}>History</button>
                  {entry.active && entry.end !== 'keep' && <button disabled={busy} onClick={() => void endNow(entry)}>End now</button>}
                  <button disabled={busy} onClick={() => void remove(entry)}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
          <p className="subtle">Each occurrence is planned shortly before it starts (six hours by default), against the channel as it is then: if the channel is edited after that, it’s skipped and says why. Planned occurrences show under File → Scheduled Changes, with the one-time overlays made by Save as Seasonal Overlay.</p>
        </>}

        {tab === 'calendar' && form && <div className="calendar-form">
          <h3 className="section-title">{editingId ? 'Edit calendar entry' : 'New calendar entry'}</h3>
          <div className="batch-options">
            <label className="field"><span>Name</span><input aria-label="Entry name" value={form.name} maxLength={120} onChange={(event) => set('name', event.target.value)} /></label>
            <label className="field"><span>Saved schedule</span><select aria-label="Saved schedule" value={form.scheduleId} onChange={(event) => set('scheduleId', event.target.value)}>
              {library?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label className="field"><span>Repeat</span><select aria-label="Repeat" value={form.kind} onChange={(event) => set('kind', event.target.value as CalendarForm['kind'])}>
              <option value="once">Once (a date, or a date range)</option><option value="yearly">Every year</option><option value="weekly">Every week</option>
            </select></label>
            <label className="field"><span>Time zone</span><select aria-label="Time zone" value={form.timeZone} onChange={(event) => set('timeZone', event.target.value)}>
              {zoneChoices(form.timeZone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select></label>
          </div>
          {form.kind === 'once' && <div className="batch-options">
            <label className="field"><span>Starts on</span><input type="date" aria-label="Start date" value={form.onceStartDate} onChange={(event) => set('onceStartDate', event.target.value)} /></label>
            <label className="field"><span>at</span><input type="time" aria-label="Start time" value={form.onceStartTime} onChange={(event) => set('onceStartTime', event.target.value)} /></label>
            <label className="check-toggle"><input type="checkbox" checked={form.onceKeep} onChange={(event) => { set('onceKeep', event.target.checked); if (event.target.checked) set('end', 'keep'); else if (form.end === 'keep') set('end', 'restore'); }} /> Keep it (no end)</label>
            {!form.onceKeep && <>
              <label className="field"><span>Ends on</span><input type="date" aria-label="End date" value={form.onceEndDate} onChange={(event) => set('onceEndDate', event.target.value)} /></label>
              <label className="field"><span>at</span><input type="time" aria-label="End time" value={form.onceEndTime} onChange={(event) => set('onceEndTime', event.target.value)} /></label>
            </>}
          </div>}
          {form.kind === 'yearly' && <div className="batch-options">
            {(['Start', 'End'] as const).map((which) => {
              const month = which === 'Start' ? 'yearStartMonth' : 'yearEndMonth';
              const day = which === 'Start' ? 'yearStartDay' : 'yearEndDay';
              const time = which === 'Start' ? 'yearStartTime' : 'yearEndTime';
              return (
                <div key={which} className="setup-row">
                  <label className="field"><span>{which}s on</span><select aria-label={`${which} month`} value={form[month]} onChange={(event) => set(month, Number(event.target.value))}>{MONTH_NAMES.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}</select></label>
                  <label className="field"><span>day</span><input type="number" min={1} max={31} aria-label={`${which} day`} value={form[day]} onChange={(event) => set(day, Math.round(Number(event.target.value)))} /></label>
                  <label className="field"><span>at</span><input type="time" aria-label={`${which} time`} value={form[time]} onChange={(event) => set(time, event.target.value)} /></label>
                </div>
              );
            })}
          </div>}
          {form.kind === 'weekly' && <>
            <fieldset className="pick-lists"><legend>Days</legend>
              {WEEKDAY_NAMES.map((name, day) => <label key={name} className="check-toggle"><input type="checkbox" checked={form.weekdays.includes(day)} onChange={() => set('weekdays', toggle(form.weekdays, day) as number[])} /> {name}</label>)}
            </fieldset>
            <div className="batch-options">
              <label className="field"><span>From</span><input type="time" aria-label="Weekly start time" value={form.weekStart} onChange={(event) => set('weekStart', event.target.value)} /></label>
              <label className="field"><span>To (earlier: past midnight)</span><input type="time" aria-label="Weekly end time" value={form.weekEnd} onChange={(event) => set('weekEnd', event.target.value)} /></label>
            </div>
          </>}
          <fieldset className="pick-lists batch-channels"><legend>Channels ({form.channelIds.length})</legend>
            <div className="batch-channel-list">
              {sorted.map((channel) => <label key={channel.id} className="check-toggle"><input type="checkbox" checked={form.channelIds.includes(channel.id)} onChange={() => set('channelIds', toggle(form.channelIds, channel.id) as string[])} /> CH {channel.number} {channel.name}</label>)}
            </div>
          </fieldset>
          <fieldset className="pick-lists batch-tasks"><legend>How it starts</legend>
            {(Object.keys(START_LABELS) as Array<keyof typeof START_LABELS>).map((mode) => <label key={mode} className="check-toggle"><input type="radio" name="calendar-start" checked={form.startMode === mode} onChange={() => set('startMode', mode)} /> {START_LABELS[mode]}</label>)}
            {form.startMode === 'position' && <label className="field"><span>Position (1 is the first item)</span><input type="number" min={1} aria-label="Start position" value={form.position} onChange={(event) => set('position', Math.max(1, Math.round(Number(event.target.value) || 1)))} /></label>}
            <label className="check-toggle"><input type="radio" name="calendar-start" disabled /> <span>Continue where the last occurrence stopped <small>{CONTINUE_UNSUPPORTED}</small></span></label>
          </fieldset>
          <fieldset className="pick-lists batch-tasks"><legend>When it ends</legend>
            {(Object.keys(END_LABELS) as Array<keyof typeof END_LABELS>).map((end) => <label key={end} className="check-toggle"><input type="radio" name="calendar-end" checked={form.end === end} disabled={(end === 'keep') !== (form.kind === 'once' && form.onceKeep)} onChange={() => set('end', end)} /> {END_LABELS[end]}</label>)}
          </fieldset>
          <div className="batch-options">
            <label className="field"><span>Priority (1–9; higher wins an overlap)</span><input type="number" min={1} max={9} aria-label="Priority" value={form.priority} onChange={(event) => set('priority', Math.min(9, Math.max(1, Math.round(Number(event.target.value) || 5))))} /></label>
            <label className="field"><span>Plan it this many hours before</span><input type="number" min={0.25} max={168} step={0.25} aria-label="Hours before to plan it" value={form.armLeadHours} onChange={(event) => set('armLeadHours', Number(event.target.value))} /></label>
            <label className="field"><span>Skip a date (YYYY-MM-DD)</span><span className="setup-row"><input type="date" aria-label="Exception date" value={exception} onChange={(event) => setException(event.target.value)} /><button disabled={!exception} onClick={() => { set('exceptions', [...new Set([...form.exceptions, exception])]); setException(''); }}>Add</button></span></label>
          </div>
          {form.exceptions.length > 0 && <div className="batch-quick" aria-label="Skipped dates">{form.exceptions.map((date) => <button key={date} aria-label={`Don’t skip ${date}`} onClick={() => set('exceptions', form.exceptions.filter((item) => item !== date))}>{date} ×</button>)}</div>}

          {check && <div className="calendar-check" aria-live="polite">
            <h3 className="section-title">Check {stale && <small>(out of date: check again)</small>}</h3>
            <ul className="room-findings" aria-label="Next occurrences">
              {check.next.map((occurrence) => <li key={occurrence.start}><span><b>{inZone(occurrence.start, form.timeZone)}{occurrence.end ? ` → ${inZone(occurrence.end, form.timeZone)}` : ', kept'}</b>{occurrence.adjusted && <small>Moved: the time written falls in an hour a clock change skips.</small>}</span></li>)}
            </ul>
            {check.conflicts.length > 0 && <ul className="room-findings" aria-label="Conflicts">
              {check.conflicts.slice(0, 12).map((conflict, index) => <li key={index} className={conflict.resolution === 'refused' ? 'severity-error' : 'severity-warning'}><em className="issue-badge">{conflict.resolution === 'refused' ? 'conflict' : 'priority'}</em><span>{conflictLine(conflict, label(conflict.channelId), form.timeZone)}</span></li>)}
            </ul>}
            {check.warnings.map((warning) => <p key={warning} className="subtle">{warning}</p>)}
          </div>}
          <div className="dialog-actions">
            <button onClick={() => setForm(null)}>Back</button>
            <button disabled={busy} className={!check || stale ? 'primary' : ''} onClick={() => void runCheck()}>Check</button>
            <button className="primary" disabled={busy || !check || stale || check.refused} onClick={() => void saveEntry()}>{editingId ? 'Save changes' : 'Save to the calendar'}</button>
          </div>
        </div>}

        {notice && <p className="subtle" role="status">{notice}</p>}
        {error && <div className="warning" role="alert"><b>Not done</b><span>{error}</span></div>}
        <p className="hint">↑ ↓ move · OK picks · Back leaves the form, then closes</p>
      </section>
    </div>
  );
}
