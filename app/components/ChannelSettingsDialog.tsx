'use client';

import { useEffect, useState } from 'react';
import { STREAM_MODE_LABELS, type ChannelSettings, type ListSummary, type TranscodeProfile, type Watermark } from '../../lib/library';
import { roleOf, ROLE_LABELS, type FillerRoles } from '../../lib/fillerRoles';
import { channelLogoUrl } from '../../lib/programInfo';
import { tunarrApi } from '../../lib/tunarrClient';

type Props = {
  channelId: string;
  /** Roles Lineup keeps for filler lists, shown next to each list. */
  fillerRoles?: FillerRoles;
  onClose: () => void;
  onSaved: (settings: ChannelSettings, startTimeChanged: boolean) => void;
};

type Collection = { id: string; weight: number; cooldownSeconds: number };
type Tab = 'general' | 'look' | 'streaming' | 'filler';
const TABS: Array<[Tab, string]> = [['general', 'General'], ['look', 'Logo & watermark'], ['streaming', 'Streaming'], ['filler', 'Commercials']];
const CORNERS: Array<[string, string]> = [['top-left', 'Top left'], ['top-right', 'Top right'], ['bottom-left', 'Bottom left'], ['bottom-right', 'Bottom right']];
const DEFAULT_WATERMARK: Watermark = { enabled: false, url: '', position: 'bottom-right', width: 10, verticalMargin: 1, horizontalMargin: 1, duration: 0, opacity: 100 };
const SETTING_KEYS = ['name', 'number', 'groupTitle', 'startTime', 'guideFlexTitle', 'guideMinimumDuration', 'fillerCollections', 'fillerRepeatCooldown', 'disableFillerOverlay', 'icon', 'watermark', 'offline', 'streamMode', 'transcodeConfigId', 'subtitlesEnabled', 'stealth', 'onDemand'] as const;
const MINUTE = 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const toLocalInput = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export function ChannelSettingsDialog({ channelId, fillerRoles = {}, onClose, onSaved }: Props) {
  const [original, setOriginal] = useState<ChannelSettings | null>(null);
  const [form, setForm] = useState<ChannelSettings | null>(null);
  const [fillerLists, setFillerLists] = useState<ListSummary[]>([]);
  const [profiles, setProfiles] = useState<TranscodeProfile[]>([]);
  const [tab, setTab] = useState<Tab>('general');
  const [logoBroken, setLogoBroken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([tunarrApi.channelSettings(channelId), tunarrApi.fillerLists(), tunarrApi.transcodeProfiles().catch(() => [] as TranscodeProfile[])])
      .then(([settings, lists, transcode]) => {
        if (cancelled) return;
        setOriginal(settings);
        setForm(structuredClone(settings));
        setFillerLists([...lists].sort((a, b) => a.name.localeCompare(b.name)));
        setProfiles(transcode);
      })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, [channelId]);

  const set = <K extends keyof ChannelSettings>(key: K, value: ChannelSettings[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const collections: Collection[] = form?.fillerCollections ?? [];
  const setCollections = (next: Collection[]) => set('fillerCollections', next);
  const changes = (() => {
    if (!form || !original) return {};
    const out: Partial<ChannelSettings> = {};
    for (const key of SETTING_KEYS) {
      if (JSON.stringify(form[key]) !== JSON.stringify(original[key])) (out as Record<string, unknown>)[key] = form[key];
    }
    return out;
  })();
  const changed = Object.keys(changes).length > 0;
  const totalWeight = collections.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  const watermark: Watermark = { ...DEFAULT_WATERMARK, ...(form?.watermark ?? {}) };
  const setWatermark = (patch: Partial<Watermark>) => set('watermark', { ...watermark, ...patch });
  const logoPath = form?.icon?.path ?? '';
  const savedLogo = channelLogoUrl({ id: channelId, icon: original?.icon }, true);
  const setLogo = (path: string) => set('icon', { ...(form?.icon ?? {}), path });

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const saved = await tunarrApi.saveChannelSettings(channelId, changes);
      onSaved(saved, 'startTime' in changes);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal channel-settings-modal" role="dialog" aria-modal="true" aria-labelledby="channel-settings-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CHANNEL</p>
        <h2 id="channel-settings-title">Channel settings</h2>
        {!form ? <p className="subtle">{error || 'Loading channel settings…'}</p> : <>
          <div className="segmented tabs" role="tablist" aria-label="Settings sections">
            {TABS.map(([value, label]) => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'primary' : ''} onClick={() => setTab(value)}>{label}</button>)}
          </div>
          {tab === 'general' && <>
          <div className="settings-grid">
            <label className="field"><span>Name</span><input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} /></label>
            <label className="field"><span>Number</span><input type="number" min={1} step={1} value={form.number ?? ''} onChange={(event) => set('number', Number(event.target.value))} /></label>
            <label className="field"><span>Group</span><input value={form.groupTitle ?? ''} onChange={(event) => set('groupTitle', event.target.value)} /></label>
            <label className="field"><span>Guide title for flex time</span><input value={form.guideFlexTitle ?? ''} placeholder="Channel name" onChange={(event) => set('guideFlexTitle', event.target.value)} /></label>
            <label className="field"><span>Hide guide entries shorter than (seconds)</span><input type="number" min={0} step={1} value={Math.round((form.guideMinimumDuration ?? 0) / 1000)} onChange={(event) => set('guideMinimumDuration', Math.max(0, Number(event.target.value)) * 1000)} /></label>
            <label className="field"><span>Lineup starts at</span><input type="datetime-local" step={1} value={form.startTime ? toLocalInput(form.startTime) : ''} onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) set('startTime', ms); }} /></label>
          </div>
          {form.startTime !== original?.startTime && <div className="warning"><b>Moving the start time shifts the whole schedule</b><span>Every program airs at a different time once this is saved.</span></div>}

            <div className="list-toolbar">
              <label><input type="checkbox" checked={!!form.stealth} onChange={(event) => set('stealth', event.target.checked)} /> Hidden channel (left out of the guide and channel list)</label>
              <label><input type="checkbox" checked={!!form.onDemand?.enabled} onChange={(event) => set('onDemand', { enabled: event.target.checked })} /> On demand (pauses when nobody is watching)</label>
            </div>
          </>}
          {tab === 'look' && <>
            <div className="logo-editor">
              <div className="logo-preview" aria-label="Saved logo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {savedLogo && !logoBroken ? <img alt="" src={savedLogo} onError={() => setLogoBroken(true)} /> : <span>{form.number}</span>}
              </div>
              <div className="settings-grid">
                <label className="field wide-field"><span>Logo image address</span><input aria-label="Logo image address" placeholder="https://…/logo.png" value={logoPath} onChange={(event) => setLogo(event.target.value.trim())} /></label>
                <label className="field"><span>Logo corner in the guide</span><select value={form.icon?.position ?? 'bottom-right'} onChange={(event) => set('icon', { ...(form.icon ?? {}), position: event.target.value })}>{CORNERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
            </div>
            {logoPath !== (original?.icon?.path ?? '') && <p className="subtle">The preview shows the saved logo; the new one appears after you save.</p>}
            <h3 className="section-title">On-screen watermark</h3>
            <div className="list-toolbar"><label><input type="checkbox" checked={watermark.enabled} onChange={(event) => setWatermark({ enabled: event.target.checked })} /> Show a watermark while this channel plays</label></div>
            {watermark.enabled && <div className="settings-grid">
              <label className="field wide-field"><span>Watermark image (empty uses the logo)</span><input aria-label="Watermark image address" value={watermark.url ?? ''} placeholder="Same as the logo" onChange={(event) => setWatermark({ url: event.target.value.trim() })} /></label>
              <label className="field"><span>Corner</span><select aria-label="Watermark corner" value={watermark.position} onChange={(event) => setWatermark({ position: event.target.value })}>{CORNERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>Width (% of the picture)</span><input type="number" min={1} max={100} step={0.5} aria-label="Watermark width" value={watermark.width} onChange={(event) => setWatermark({ width: Math.min(100, Math.max(1, Number(event.target.value))) })} /></label>
              <label className="field"><span>Margin from the side (%)</span><input type="number" min={0} max={100} step={0.5} aria-label="Watermark side margin" value={watermark.horizontalMargin} onChange={(event) => setWatermark({ horizontalMargin: Math.min(100, Math.max(0, Number(event.target.value))) })} /></label>
              <label className="field"><span>Margin from the edge (%)</span><input type="number" min={0} max={100} step={0.5} aria-label="Watermark edge margin" value={watermark.verticalMargin} onChange={(event) => setWatermark({ verticalMargin: Math.min(100, Math.max(0, Number(event.target.value))) })} /></label>
              <label className="field"><span>Opacity (%)</span><input type="number" min={0} max={100} step={5} aria-label="Watermark opacity" value={watermark.opacity ?? 100} onChange={(event) => setWatermark({ opacity: Math.min(100, Math.max(0, Math.round(Number(event.target.value)))) })} /></label>
              <label className="field"><span>Show for (seconds, 0 = always)</span><input type="number" min={0} step={1} aria-label="Watermark duration" value={watermark.duration} onChange={(event) => setWatermark({ duration: Math.max(0, Number(event.target.value)) })} /></label>
            </div>}
            <h3 className="section-title">When nothing is scheduled</h3>
            <div className="settings-grid">
              <label className="field"><span>Offline screen</span><select aria-label="Offline screen" value={form.offline?.mode ?? 'pic'} onChange={(event) => set('offline', { ...(form.offline ?? { picture: '', soundtrack: '' }), mode: event.target.value as 'pic' | 'clip' })}><option value="pic">A picture</option><option value="clip">A filler clip</option></select></label>
              {(form.offline?.mode ?? 'pic') === 'pic' && <label className="field wide-field"><span>Picture address (empty uses Tunarr’s default)</span><input aria-label="Offline picture address" value={form.offline?.picture ?? ''} onChange={(event) => set('offline', { mode: 'pic', soundtrack: form.offline?.soundtrack ?? '', picture: event.target.value.trim() })} /></label>}
            </div>
          </>}
          {tab === 'streaming' && <>
            <div className="settings-grid">
              <label className="field"><span>Stream format</span><select aria-label="Stream format" value={form.streamMode ?? 'hls'} onChange={(event) => set('streamMode', event.target.value)}>{Object.entries(STREAM_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="field"><span>Transcode profile</span><select aria-label="Transcode profile" value={form.transcodeConfigId ?? ''} onChange={(event) => set('transcodeConfigId', event.target.value)}>
                {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.isDefault ? ' (default)' : ''} · {profile.resolution ? `${profile.resolution.widthPx}×${profile.resolution.heightPx}` : ''} {profile.videoFormat ?? ''}</option>)}
                {!profiles.some((profile) => profile.id === form.transcodeConfigId) && <option value={form.transcodeConfigId ?? ''}>Current profile</option>}
              </select></label>
            </div>
            <div className="list-toolbar"><label><input type="checkbox" checked={!!form.subtitlesEnabled} onChange={(event) => set('subtitlesEnabled', event.target.checked)} /> Subtitles</label></div>
            <p className="subtle">Edit what a profile does (resolution, bitrates, hardware acceleration) in Setup → Transcode Profiles…. Direct modes skip transcoding, so the profile only applies to HLS and MPEG-TS.</p>
          </>}
          {tab === 'filler' && <>
          <h3 className="section-title">Commercials during flex time</h3>
          <p className="subtle">Flex time is airtime Tunarr leaves open: flex items in the lineup, slot padding, and breaks without their own lists. Tunarr fills it from these filler lists, picking by weight; with none, it shows the offline screen.</p>
          <div className="candidate-list filler-collections">
            {!collections.length && <p className="subtle candidate-empty">No filler. Flex time shows the offline screen.</p>}
            {collections.map((collection, index) => (
              <div className="candidate filler-row" key={`${collection.id}-${index}`}>
                <select aria-label={`Filler list ${index + 1}`} value={collection.id} onChange={(event) => setCollections(collections.map((item, i) => (i === index ? { ...item, id: event.target.value } : item)))}>
                  {fillerLists.map((list) => { const role = roleOf(list, fillerRoles); return <option key={list.id} value={list.id}>{list.name}{role ? ` (${ROLE_LABELS[role]})` : ''}</option>; })}
                  {!fillerLists.some((list) => list.id === collection.id) && <option value={collection.id}>Missing list</option>}
                </select>
                <label>Weight <input type="number" min={0} step={1} aria-label={`Filler list ${index + 1} weight`} value={collection.weight} onChange={(event) => setCollections(collections.map((item, i) => (i === index ? { ...item, weight: Math.max(0, Number(event.target.value)) } : item)))} /> <small>{totalWeight ? `${Math.round((Math.max(0, collection.weight) / totalWeight) * 100)}%` : ''}</small></label>
                <label>Cooldown <input type="number" min={0} step={1} aria-label={`Filler list ${index + 1} cooldown minutes`} value={Math.round(collection.cooldownSeconds / 60)} onChange={(event) => setCollections(collections.map((item, i) => (i === index ? { ...item, cooldownSeconds: Math.max(0, Number(event.target.value)) * 60 } : item)))} /> min</label>
                <button aria-label={`Remove filler list ${index + 1}`} onClick={() => setCollections(collections.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}
          </div>
          <div className="list-toolbar">
            <button disabled={!fillerLists.length} onClick={() => setCollections([...collections, { id: fillerLists.find((list) => !collections.some((item) => item.id === list.id))?.id ?? fillerLists[0].id, weight: 1, cooldownSeconds: 0 }])}>Add filler list</button>
            <label>Don’t repeat a filler within <input type="number" min={0} step={1} aria-label="Filler repeat cooldown minutes" value={Math.round((form.fillerRepeatCooldown ?? 0) / MINUTE)} onChange={(event) => set('fillerRepeatCooldown', Math.max(0, Number(event.target.value)) * MINUTE)} /> min</label>
            <label><input type="checkbox" checked={!!form.disableFillerOverlay} onChange={(event) => set('disableFillerOverlay', event.target.checked)} /> Hide the channel watermark during filler</label>
          </div>
          </>}
          {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
        </>}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!changed || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </section>
    </div>
  );
}
