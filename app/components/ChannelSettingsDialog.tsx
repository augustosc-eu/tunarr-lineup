'use client';

import { useEffect, useState } from 'react';
import type { ChannelSettings, ListSummary } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';

type Props = {
  channelId: string;
  onClose: () => void;
  onSaved: (settings: ChannelSettings, startTimeChanged: boolean) => void;
};

type Collection = { id: string; weight: number; cooldownSeconds: number };
const MINUTE = 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const toLocalInput = (ms: number) => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

export function ChannelSettingsDialog({ channelId, onClose, onSaved }: Props) {
  const [original, setOriginal] = useState<ChannelSettings | null>(null);
  const [form, setForm] = useState<ChannelSettings | null>(null);
  const [fillerLists, setFillerLists] = useState<ListSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([tunarrApi.channelSettings(channelId), tunarrApi.fillerLists()])
      .then(([settings, lists]) => {
        if (cancelled) return;
        setOriginal(settings);
        setForm(structuredClone(settings));
        setFillerLists([...lists].sort((a, b) => a.name.localeCompare(b.name)));
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
    for (const key of ['name', 'number', 'groupTitle', 'startTime', 'guideFlexTitle', 'guideMinimumDuration', 'fillerCollections', 'fillerRepeatCooldown', 'disableFillerOverlay'] as const) {
      if (JSON.stringify(form[key]) !== JSON.stringify(original[key])) (out as Record<string, unknown>)[key] = form[key];
    }
    return out;
  })();
  const changed = Object.keys(changes).length > 0;
  const totalWeight = collections.reduce((sum, item) => sum + Math.max(0, item.weight), 0);

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
          <div className="settings-grid">
            <label className="field"><span>Name</span><input value={form.name ?? ''} onChange={(event) => set('name', event.target.value)} /></label>
            <label className="field"><span>Number</span><input type="number" min={1} step={1} value={form.number ?? ''} onChange={(event) => set('number', Number(event.target.value))} /></label>
            <label className="field"><span>Group</span><input value={form.groupTitle ?? ''} onChange={(event) => set('groupTitle', event.target.value)} /></label>
            <label className="field"><span>Guide title for flex time</span><input value={form.guideFlexTitle ?? ''} placeholder="Channel name" onChange={(event) => set('guideFlexTitle', event.target.value)} /></label>
            <label className="field"><span>Hide guide entries shorter than (seconds)</span><input type="number" min={0} step={1} value={Math.round((form.guideMinimumDuration ?? 0) / 1000)} onChange={(event) => set('guideMinimumDuration', Math.max(0, Number(event.target.value)) * 1000)} /></label>
            <label className="field"><span>Lineup starts at</span><input type="datetime-local" step={1} value={form.startTime ? toLocalInput(form.startTime) : ''} onChange={(event) => { const ms = new Date(event.target.value).getTime(); if (Number.isFinite(ms)) set('startTime', ms); }} /></label>
          </div>
          {form.startTime !== original?.startTime && <div className="warning"><b>Moving the start time shifts the whole schedule</b><span>Every program airs at a different time once this is saved.</span></div>}

          <h3 className="section-title">Commercials during flex time</h3>
          <p className="subtle">When this channel has flex time, Tunarr fills it from these filler lists, picking by weight.</p>
          <div className="candidate-list filler-collections">
            {!collections.length && <p className="subtle candidate-empty">No filler. Flex time shows the offline screen.</p>}
            {collections.map((collection, index) => (
              <div className="candidate filler-row" key={`${collection.id}-${index}`}>
                <select aria-label={`Filler list ${index + 1}`} value={collection.id} onChange={(event) => setCollections(collections.map((item, i) => (i === index ? { ...item, id: event.target.value } : item)))}>
                  {fillerLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
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
