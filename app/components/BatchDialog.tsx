'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { LibraryBrowser } from './LibraryBrowser';
import { dpadKey, keepFocusIn } from '../dpad';
import type { PartBlocker } from '../../lib/compatibility';
import { applyBody, countOutcomes, defaultDecisions, defaultMapping, durationLabel, inProgress, OUTCOME_LABELS, outcomeLine, outcomeTone, PREVIEW_LABELS, readyChannels, REPAIR_LABELS, rollbackable, sequentialNumbers, TASKS, type BatchPreview, type BatchRecord, type BatchSummary, type BatchTask, type RepairDecision } from '../../lib/batch';
import type { Channel } from '../../lib/lineup';
import { lineupEntry, type ChannelSettings, type TranscodeProfile } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';
import { validatePackage, type ProgrammingPackage } from '../../server/programmingPackage';

type Props = {
  channels: Channel[];
  activeChannelId: string;
  initialTask: BatchTask;
  /** Channels picked to start with (the desk's channel otherwise). */
  initialChannels?: string[];
  /** Channels with unsaved work in the desk; a batch that changes their lineup makes that work stale. */
  drafts: Record<string, boolean>;
  onDone: (message: string, changedIds: string[]) => void;
  onClose: () => void;
  /** Why this Tunarr refuses part of a task (looking up replacement programs), from the compatibility report. */
  blocked?: PartBlocker;
};

type Step = 'setup' | 'preview' | 'confirm' | 'report' | 'history';
type Options = { stealth: boolean | null; onDemand: boolean | null; subtitlesEnabled: boolean | null; streamMode: string | null; guideFlexTitle: string | null; guideMinimumSeconds: number | null };

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const label = (channel: Pick<Channel, 'number' | 'name'>) => `CH ${channel.number} ${channel.name}`;
const STREAM_MODES = [['hls', 'HLS'], ['hls_slower', 'HLS (slower, alternate)'], ['mpegts', 'MPEG-TS'], ['hls_direct', 'HLS direct'], ['hls_direct_v2', 'HLS direct v2']] as const;
const when = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const POLL_MS = 700;

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Channel → Batch Operations…: one change across many channels, always
 * previewed per channel, applied channel by channel (each checked again and
 * snapshotted first), reported, and rolled back by choice. Also media repair
 * and programming packages. Arrows move between controls, OK picks, Back steps
 * back (out of a confirmation or the library first), then closes.
 */
export function BatchDialog({ channels, activeChannelId, initialTask, initialChannels, drafts, onDone, onClose, blocked }: Props) {
  // Replacements are each looked up in Tunarr; without that route, only remove, flex and leave are offered.
  const noReplace = blocked?.('library-search', 'lookup') ?? null;
  const sorted = useMemo(() => [...channels].sort((a, b) => a.number - b.number), [channels]);
  const [task, setTask] = useState<BatchTask>(initialTask);
  const [picked, setPicked] = useState<string[]>(() => initialChannels ?? (activeChannelId ? [activeChannelId] : []));
  const [step, setStep] = useState<Step>('setup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Operation settings.
  const [fillerFrom, setFillerFrom] = useState(activeChannelId || sorted[0]?.id || '');
  const [fillerSource, setFillerSource] = useState<ChannelSettings | null>(null);
  const [group, setGroup] = useState('');
  const [profiles, setProfiles] = useState<TranscodeProfile[]>([]);
  const [profileId, setProfileId] = useState('');
  const [numbers, setNumbers] = useState<Record<string, number>>({});
  const [startAt, setStartAt] = useState(1);
  const [options, setOptions] = useState<Options>({ stealth: null, onDemand: null, subtitlesEnabled: null, streamMode: null, guideFlexTitle: null, guideMinimumSeconds: null });
  const [decisions, setDecisions] = useState<Record<string, RepairDecision>>({});
  const [replacementNames, setReplacementNames] = useState<Record<string, string>>({});
  const [picker, setPicker] = useState<string | null>(null);
  const [pkg, setPkg] = useState<ProgrammingPackage | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // Results.
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [record, setRecord] = useState<(BatchRecord & { running?: boolean }) | null>(null);
  const [rollbackPick, setRollbackPick] = useState<string[]>([]);
  const [history, setHistory] = useState<BatchSummary[] | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const reported = useRef('');
  // The request the preview showed: apply sends only that, so nothing unpreviewed is ever saved.
  const [previewedWith, setPreviewedWith] = useState('');

  const byId = useMemo(() => new Map(sorted.map((channel) => [channel.id, channel])), [sorted]);
  const groups = useMemo(() => [...new Set(sorted.map((channel) => channel.groupTitle?.trim()).filter((name): name is string => !!name))], [sorted]);

  // Opened from a menu or the Control Room: take the focus, so the remote's keys land here.
  useEffect(() => {
    sectionRef.current?.querySelector<HTMLInputElement>('input[name="batch-task"]:checked')?.focus();
  }, []);

  // What each operation needs from Tunarr before it can be configured.
  useEffect(() => {
    let cancelled = false;
    if (task === 'transcode' && !profiles.length) tunarrApi.transcodeProfiles().then((list) => { if (!cancelled) { setProfiles(list); setProfileId((current) => current || list.find((item) => item.isDefault)?.id || list[0]?.id || ''); } }).catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    if (task === 'filler' && fillerFrom) tunarrApi.channelSettings(fillerFrom).then((settings) => { if (!cancelled) setFillerSource(settings); }).catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [task, fillerFrom, profiles.length]);

  // Follow a running batch (or rollback) until it finishes.
  useEffect(() => {
    if (!record || !inProgress(record)) return;
    const timer = window.setTimeout(() => { tunarrApi.batch(record.id).then(setRecord, (reason) => setError(errorText(reason))); }, POLL_MS);
    return () => window.clearTimeout(timer);
  }, [record]);

  // Tell the desk once a batch has finished, so it reloads what changed.
  useEffect(() => {
    if (!record || inProgress(record)) return;
    const key = `${record.id}:${record.channels.map((channel) => `${channel.status}${channel.rollback?.status ?? ''}`).join()}`;
    if (reported.current === key) return;
    reported.current = key;
    const changed = record.channels.filter((channel) => channel.status === 'done' || channel.rollback?.status === 'done' || channel.before).map((channel) => channel.channelId);
    onDone(`${record.label}: ${outcomeLine(countOutcomes(record))}.`, changed);
  }, [record, onDone]);

  const togglePick = (id: string, on: boolean) => setPicked((current) => (on ? [...new Set([...current, id])] : current.filter((item) => item !== id)));

  /** The request for the current task, or why it isn't ready. */
  const request = (): { operation: string; channelIds?: string[]; params: unknown } | { error: string } => {
    const channelIds = sorted.filter((channel) => picked.includes(channel.id)).map((channel) => channel.id);
    if (task !== 'import' && !channelIds.length) return { error: 'Pick at least one channel.' };
    switch (task) {
      case 'filler':
        if (!fillerSource) return { error: 'Reading the channel to copy from…' };
        return { operation: task, channelIds: channelIds.filter((id) => id !== fillerFrom), params: { changes: { fillerCollections: fillerSource.fillerCollections ?? [], fillerRepeatCooldown: fillerSource.fillerRepeatCooldown ?? 30_000, disableFillerOverlay: !!fillerSource.disableFillerOverlay } } };
      case 'group': return { operation: task, channelIds, params: { changes: { groupTitle: group.trim() } } };
      case 'transcode': return profileId ? { operation: task, channelIds, params: { changes: { transcodeConfigId: profileId } } } : { error: 'Choose a transcode profile.' };
      case 'renumber': return { operation: task, channelIds, params: { numbers: Object.fromEntries(channelIds.map((id) => [id, numbers[id] ?? byId.get(id)!.number])) } };
      case 'settings': {
        const changes: Record<string, unknown> = {};
        if (options.stealth !== null) changes.stealth = options.stealth;
        if (options.onDemand !== null) changes.onDemand = { enabled: options.onDemand };
        if (options.subtitlesEnabled !== null) changes.subtitlesEnabled = options.subtitlesEnabled;
        if (options.streamMode !== null) changes.streamMode = options.streamMode;
        if (options.guideFlexTitle !== null) changes.guideFlexTitle = options.guideFlexTitle;
        if (options.guideMinimumSeconds !== null) changes.guideMinimumDuration = Math.max(0, Math.round(options.guideMinimumSeconds * 1000));
        return Object.keys(changes).length ? { operation: task, channelIds, params: { changes } } : { error: 'Choose at least one option to change.' };
      }
      case 'repair': return { operation: task, channelIds, params: { decisions } };
      case 'import': {
        if (!pkg) return { error: 'Choose a package file.' };
        const chosen = Object.fromEntries(Object.entries(mapping).filter(([, to]) => to));
        return Object.keys(chosen).length ? { operation: task, params: { package: pkg, mapping: chosen } } : { error: 'Choose where at least one packaged lineup goes.' };
      }
      default: return { error: 'Choose what to do.' };
    }
  };

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

  const runPreview = () => run(async () => {
    if (task === 'export') {
      const ids = sorted.filter((channel) => picked.includes(channel.id)).map((channel) => channel.id);
      if (!ids.length) throw new Error('Pick at least one channel.');
      const exported = await tunarrApi.batchExport(ids);
      download(`tunarr-lineup-package-${new Date().toISOString().slice(0, 10)}.json`, exported);
      setNotice(`Exported ${exported.channels.length} channel${exported.channels.length === 1 ? '' : 's'}. Nothing in Tunarr changed.`);
      return;
    }
    const body = request();
    if ('error' in body) throw new Error(body.error);
    const next = await tunarrApi.batchPreview(body);
    setPreview(next);
    setPreviewedWith(JSON.stringify(body));
    if (next.missing) setDecisions((current) => defaultDecisions(next.missing!, current));
    setStep('preview');
  });

  const apply = () => run(async () => {
    const body = request();
    if ('error' in body || !preview) throw new Error('error' in body ? body.error : 'Preview first.');
    if (JSON.stringify(body) !== previewedWith) throw new Error('The choices changed since the preview. Update the preview first.');
    const started = await tunarrApi.batchApply(applyBody(body, preview));
    setRecord(started);
    setRollbackPick([]);
    setStep('report');
  });

  const rollBack = () => run(async () => {
    if (!record) return;
    setRecord(await tunarrApi.batchRollback(record.id, rollbackPick));
    setRollbackPick([]);
  });

  const openHistory = () => run(async () => {
    setStep('history');
    setHistory(await tunarrApi.batches());
  });

  const openRecord = (id: string) => run(async () => {
    setRecord(await tunarrApi.batch(id));
    reported.current = '';
    setRollbackPick([]);
    setStep('report');
  });

  const readPackage = async (file: File) => {
    setError('');
    try {
      const checked = validatePackage(JSON.parse(await file.text()));
      if ('error' in checked) throw new Error(checked.error);
      setPkg(checked.package);
      setMapping(defaultMapping(checked.package.channels, sorted));
    } catch (reason) {
      setPkg(null);
      setError(reason instanceof SyntaxError ? 'That file isn’t JSON.' : errorText(reason));
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (back(key)) {
      event.preventDefault();
      event.stopPropagation();
      if (picker) setPicker(null);
      else if (step === 'confirm') setStep('preview');
      else onClose();
      return;
    }
    if (!picker) dpadKey(event, sectionRef.current);
  };

  const ready = readyChannels(preview);
  const missing = preview?.missing ?? [];
  /** The replacement's length as Tunarr described it in the last preview (what the save will use). */
  const replacementLength = (programId: string) => { const id = decisions[programId]?.replacement?.id; return preview?.replacements?.find((item) => item.id === id)?.duration; };
  const taskInfo = TASKS.find((item) => item.id === task)!;
  const current = request();
  const stale = !!preview && JSON.stringify(current) !== previewedWith;

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} className="modal batch-modal" role="dialog" aria-modal="true" aria-labelledby="batch-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CHANNELS</p>
        <h2 id="batch-title">Batch operations</h2>
        <div className="room-filters" role="toolbar" aria-label="Batch views">
          <button aria-pressed={step !== 'history' && step !== 'report'} className={step !== 'history' && step !== 'report' ? 'primary' : ''} onClick={() => { setStep('setup'); setPreview(null); }}>New batch</button>
          <button aria-pressed={step === 'history'} className={step === 'history' ? 'primary' : ''} onClick={() => void openHistory()}>Recent batches</button>
        </div>

        {step === 'setup' && <>
          <fieldset className="pick-lists batch-tasks">
            <legend>What to do</legend>
            {TASKS.map((item) => (
              <label key={item.id} className="check-toggle">
                <input type="radio" name="batch-task" checked={task === item.id} onChange={() => { setTask(item.id); setPreview(null); setError(''); setNotice(''); }} />
                <span><b>{item.label}</b> <small>{item.help}</small></span>
              </label>
            ))}
          </fieldset>

          {task !== 'import' && <fieldset className="pick-lists batch-channels">
            <legend>Channels ({picked.length} picked)</legend>
            <div className="batch-quick">
              <button onClick={() => setPicked(sorted.map((channel) => channel.id))}>All</button>
              <button onClick={() => setPicked([])}>None</button>
              {groups.map((name) => <button key={name} onClick={() => setPicked(sorted.filter((channel) => channel.groupTitle?.trim() === name).map((channel) => channel.id))}>{name}</button>)}
            </div>
            <div className="batch-channel-list">
              {sorted.map((channel) => (
                <label key={channel.id} className="check-toggle">
                  <input type="checkbox" checked={picked.includes(channel.id)} onChange={(event) => togglePick(channel.id, event.target.checked)} />
                  {label(channel)}{channel.groupTitle ? <small> · {channel.groupTitle}</small> : null}
                  {drafts[channel.id] && task === 'repair' && <small> · has unsaved work in the desk, which this makes stale</small>}
                </label>
              ))}
            </div>
          </fieldset>}

          <div className="batch-params" aria-label={taskInfo.label}>
            {task === 'filler' && <>
              <label className="field"><span>Copy from</span><select aria-label="Copy filler settings from" value={fillerFrom} onChange={(event) => { setFillerFrom(event.target.value); setFillerSource(null); }}>
                {sorted.map((channel) => <option key={channel.id} value={channel.id}>{label(channel)}</option>)}
              </select></label>
              <p className="subtle">{fillerSource ? `${fillerSource.fillerCollections?.length ?? 0} filler list${fillerSource.fillerCollections?.length === 1 ? '' : 's'}, repeat cooldown ${Math.round((fillerSource.fillerRepeatCooldown ?? 0) / 1000)} s, watermark ${fillerSource.disableFillerOverlay ? 'hidden' : 'shown'} during filler. The channel copied from isn’t changed.` : 'Reading it…'}</p>
            </>}
            {task === 'group' && <label className="field"><span>Group title (empty: none)</span><input aria-label="Group title" value={group} maxLength={200} onChange={(event) => setGroup(event.target.value)} /></label>}
            {task === 'transcode' && <label className="field"><span>Transcode profile</span><select aria-label="Transcode profile" value={profileId} onChange={(event) => setProfileId(event.target.value)}>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? ' (default)' : ''}</option>)}
            </select></label>}
            {task === 'renumber' && <>
              <div className="setup-row">
                <label className="field"><span>Start at</span><input type="number" aria-label="Start numbering at" min={1} value={startAt} onChange={(event) => setStartAt(Math.max(1, Math.round(Number(event.target.value) || 1)))} /></label>
                <button onClick={() => setNumbers(sequentialNumbers(sorted.filter((channel) => picked.includes(channel.id)).map((channel) => channel.id), startAt))}>Number them in order</button>
              </div>
              <div className="batch-numbers">
                {sorted.filter((channel) => picked.includes(channel.id)).map((channel) => (
                  <label key={channel.id} className="field"><span>{label(channel)} →</span><input type="number" aria-label={`New number for ${label(channel)}`} min={1} value={numbers[channel.id] ?? channel.number} onChange={(event) => setNumbers((current) => ({ ...current, [channel.id]: Math.round(Number(event.target.value)) }))} /></label>
                ))}
              </div>
            </>}
            {task === 'settings' && <div className="batch-options">
              {([['stealth', 'Hidden channel'], ['onDemand', 'On demand'], ['subtitlesEnabled', 'Subtitles']] as const).map(([key, text]) => (
                <label key={key} className="field"><span>{text}</span><select aria-label={text} value={options[key] === null ? '' : options[key] ? 'on' : 'off'} onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.value === '' ? null : event.target.value === 'on' }))}>
                  <option value="">Leave as it is</option><option value="on">On</option><option value="off">Off</option>
                </select></label>
              ))}
              <label className="field"><span>Stream format</span><select aria-label="Stream format" value={options.streamMode ?? ''} onChange={(event) => setOptions((current) => ({ ...current, streamMode: event.target.value || null }))}>
                <option value="">Leave as it is</option>{STREAM_MODES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
              </select></label>
              <label className="field"><span>Guide title for flex (empty: leave)</span><input aria-label="Guide title for flex" value={options.guideFlexTitle ?? ''} onChange={(event) => setOptions((current) => ({ ...current, guideFlexTitle: event.target.value || null }))} /></label>
              <label className="field"><span>Minimum guide entry, seconds (empty: leave)</span><input type="number" min={0} aria-label="Minimum guide entry in seconds" value={options.guideMinimumSeconds ?? ''} onChange={(event) => setOptions((current) => ({ ...current, guideMinimumSeconds: event.target.value === '' ? null : Number(event.target.value) }))} /></label>
            </div>}
            {task === 'repair' && <p className="subtle">Preview finds every program Tunarr no longer has on the channels picked, where it is and when it airs next. Then choose what to do with each; nothing changes until you apply. Channels generated from a slot schedule are left alone (a manual save would detach them).</p>}
            {task === 'export' && <p className="subtle">The file holds each channel’s lineup exactly as Tunarr has it, with program titles. No addresses, tokens, media paths or channel settings.</p>}
            {task === 'import' && <>
              <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Package file" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readPackage(file); event.target.value = ''; }} />
              <button onClick={() => fileRef.current?.click()}>{pkg ? 'Choose another package file…' : 'Choose a package file…'}</button>
              {pkg && <div className="batch-numbers">
                <p className="subtle">Exported {pkg.exportedAt.slice(0, 10) || 'at an unknown date'} · {pkg.channels.length} channel{pkg.channels.length === 1 ? '' : 's'}. Each goes to the channel you choose here, replacing its lineup.</p>
                {pkg.channels.map((source) => (
                  <label key={source.id} className="field"><span>{label(source)} ({source.lineup.length} items{source.hadSchedule ? ', from a slot schedule' : ''}) →</span>
                    <select aria-label={`Put ${label(source)} on`} value={mapping[source.id] ?? ''} onChange={(event) => setMapping((current) => ({ ...current, [source.id]: event.target.value }))}>
                      <option value="">Don’t import</option>
                      {sorted.map((channel) => <option key={channel.id} value={channel.id}>{label(channel)}</option>)}
                    </select>
                  </label>
                ))}
              </div>}
            </>}
          </div>
          <div className="dialog-actions">
            <button onClick={onClose}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void runPreview()}>{busy ? 'Working…' : task === 'export' ? `Export ${picked.length} channel${picked.length === 1 ? '' : 's'}` : 'Preview'}</button>
          </div>
        </>}

        {(step === 'preview' || step === 'confirm') && preview && <>
          <h3 className="section-title">{preview.label}</h3>
          <p className="subtle">{ready.length} will change · {preview.channels.filter((channel) => channel.status === 'unchanged').length} no change · {preview.channels.filter((channel) => channel.status === 'blocked').length} blocked. Each channel is checked again when it’s applied.</p>
          {task === 'repair' && <div className="batch-missing">
            <h3 className="section-title">Missing programs ({missing.length})</h3>
            {!missing.length && <p className="issue-empty">No missing programs on these channels.</p>}
            {missing.length > 0 && noReplace && <div className="warning" role="note"><b>Replacing isn’t available</b><span>{noReplace}</span></div>}
            {missing.map((item) => (
              <div key={item.programId} className="batch-missing-row">
                <span><b>A program Tunarr no longer has ({durationLabel(item.duration)})</b>
                  <small>{item.occurrences.map((occurrence) => `${byId.get(occurrence.channelId) ? label(byId.get(occurrence.channelId)!) : occurrence.channelId} at #${occurrence.positions.map((index) => index + 1).join(', #')}${occurrence.nextAirings[0] ? ` (next ${when(occurrence.nextAirings[0])})` : ''}`).join(' · ')}</small>
                  <small>Id {item.programId}</small></span>
                <select aria-label={`What to do with the missing program ${item.programId}`} value={decisions[item.programId]?.action ?? 'ignore'} onChange={(event) => {
                  const action = event.target.value as RepairDecision['action'];
                  if (action === 'replace') setPicker(item.programId);
                  else setDecisions((current) => ({ ...current, [item.programId]: { action } }));
                }}>
                  {(Object.keys(REPAIR_LABELS) as Array<RepairDecision['action']>).map((action) => <option key={action} value={action} disabled={action === 'replace' && !!noReplace}>{REPAIR_LABELS[action]}</option>)}
                </select>
                {decisions[item.programId]?.action === 'replace' && <button onClick={() => setPicker(item.programId)}>{replacementNames[item.programId] ? `With “${replacementNames[item.programId]}”${replacementLength(item.programId) ? ` (${durationLabel(replacementLength(item.programId)!)} in Tunarr)` : ''}` : 'Choose a program…'}</button>}
              </div>
            ))}
            {missing.length > 0 && <div className="dialog-actions">{stale && <span className="subtle">Your choices changed: update the preview before applying.</span>}<button className={stale ? 'primary' : ''} disabled={busy} onClick={() => void runPreview()}>Update preview with these choices</button></div>}
          </div>}
          <ul className="issue-list batch-preview" aria-label="Changes per channel">
            {preview.channels.map((channel) => (
              <li key={channel.channelId} className={`issue health-${outcomeTone(channel.status)}`}>
                <em className="issue-badge">{PREVIEW_LABELS[channel.status]}</em>
                <span><b>{label(channel)}</b>
                  {channel.changes?.map((change) => <small key={change.field}>{change.label}: {change.before} → {change.after}</small>)}
                  {channel.programming && <small>{channel.programming.itemsBefore} → {channel.programming.itemsAfter} items · {durationLabel(channel.programming.lengthBefore)} → {durationLabel(channel.programming.lengthAfter)} a pass{channel.programming.removed ? ` · ${channel.programming.removed} removed` : ''}{channel.programming.flexed ? ` · ${channel.programming.flexed} turned into flex` : ''}{channel.programming.replaced ? ` · ${channel.programming.replaced} replaced` : ''}{channel.programming.positions.length ? ` (at #${channel.programming.positions.map((index) => index + 1).join(', #')})` : ''}</small>}
                  {channel.reason && <small>{channel.reason}</small>}
                </span>
              </li>
            ))}
          </ul>
          {step === 'confirm' && <div className="warning" role="alert">
            <b>Save {ready.length} channel{ready.length === 1 ? '' : 's'} in Tunarr?</b>
            <span>Each channel is read again first: one that changed since this preview is left alone and reported as a conflict, and the others still go in. {task === 'repair' || task === 'import' ? 'A snapshot of each lineup is kept first.' : 'Each channel’s old values are kept.'} Any channel can be rolled back afterwards, as long as it hasn’t changed again.</span>
          </div>}
          <div className="dialog-actions">
            <button onClick={() => (step === 'confirm' ? setStep('preview') : setStep('setup'))}>Back</button>
            {step === 'preview'
              ? <button className="primary" disabled={!ready.length || busy || stale} onClick={() => setStep('confirm')}>Apply to {ready.length} channel{ready.length === 1 ? '' : 's'}…</button>
              : <button className="primary" disabled={busy} onClick={() => void apply()}>{busy ? 'Starting…' : `Apply to ${ready.length} channel${ready.length === 1 ? '' : 's'}`}</button>}
          </div>
        </>}

        {step === 'report' && record && <>
          <h3 className="section-title">{record.label}</h3>
          <p className="subtle" aria-live="polite">{inProgress(record) ? `Working… ${record.channels.filter((channel) => channel.status !== 'pending').length} of ${record.channels.length}` : `${outcomeLine(countOutcomes(record))} · ${new Date(record.createdAt).toLocaleString()}`}</p>
          <ul className="issue-list batch-report" aria-label="Result per channel">
            {record.channels.map((channel) => {
              const canRollBack = !inProgress(record) && rollbackable(record).some((item) => item.channelId === channel.channelId);
              return (
                <li key={channel.channelId} className={`issue health-${outcomeTone(channel.status)}`}>
                  <em className="issue-badge">{OUTCOME_LABELS[channel.status]}</em>
                  <span><b>{label(channel)}</b><small>{channel.message}</small>{channel.rollback && <small>Rollback: {channel.rollback.message}</small>}</span>
                  {canRollBack && <label className="check-toggle"><input type="checkbox" aria-label={`Roll back ${label(channel)}`} checked={rollbackPick.includes(channel.channelId)} onChange={(event) => setRollbackPick((current) => (event.target.checked ? [...current, channel.channelId] : current.filter((id) => id !== channel.channelId)))} /> Roll back</label>}
                </li>
              );
            })}
          </ul>
          <div className="dialog-actions">
            <button onClick={() => { setStep('setup'); setPreview(null); setRecord(null); }}>New batch</button>
            <button disabled={!rollbackPick.length || busy || inProgress(record)} onClick={() => void rollBack()}>Roll back {rollbackPick.length || ''} channel{rollbackPick.length === 1 ? '' : 's'}</button>
            <button className="primary" onClick={onClose}>Close</button>
          </div>
        </>}

        {step === 'history' && <>
          <h3 className="section-title">Recent batches</h3>
          <ul className="issue-list" aria-label="Recent batches">
            {!history && <li className="issue-empty">Loading…</li>}
            {history?.length === 0 && <li className="issue-empty">No batches yet.</li>}
            {history?.map((item) => (
              <li key={item.id}><button className="issue health-unknown" onClick={() => void openRecord(item.id)}>
                <em className="issue-badge">{item.operation}</em>
                <span><b>{item.label}</b><small>{new Date(item.createdAt).toLocaleString()} · {outcomeLine(item.counts)}{item.rolledBack ? ` · ${item.rolledBack} rolled back` : ''}</small></span>
              </button></li>
            ))}
          </ul>
        </>}

        {notice && <p className="subtle" role="status">{notice}</p>}
        {error && <div className="warning" role="alert"><b>Not done</b><span>{error}</span></div>}
        <p className="hint">↑ ↓ move · OK picks · Back steps back, then closes</p>
        {picker && <LibraryBrowser title="Replace the missing program with" mode="programs" confirmLabel="Use" onClose={() => { setPicker(null); }} onPick={(pick) => {
          const program = 'programs' in pick ? pick.programs[0] : undefined;
          if (program) {
            const { item } = lineupEntry(program);
            const title = typeof (program.program as { title?: unknown }).title === 'string' ? (program.program as { title: string }).title : 'a program';
            // Only the id: the companion looks the program up in Tunarr and uses its length.
            setDecisions((current) => ({ ...current, [picker]: { action: 'replace', replacement: { id: item.id! } } }));
            setReplacementNames((current) => ({ ...current, [picker]: title }));
          }
          setPicker(null);
        }} />}
      </section>
    </div>
  );
}
