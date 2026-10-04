'use client';

import { useCallback, useEffect, useState } from 'react';
import type { TranscodeProfile } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';

type Props = { onClose: () => void };

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const RESOLUTIONS: Array<[number, number, string]> = [[640, 360, '360p'], [854, 480, '480p'], [1280, 720, '720p HD'], [1920, 1080, '1080p Full HD'], [2560, 1440, '1440p'], [3840, 2160, '2160p 4K']];
const HW: Record<string, string> = { none: 'None (software)', videotoolbox: 'VideoToolbox (Mac)', cuda: 'NVIDIA (CUDA/NVENC)', qsv: 'Intel Quick Sync', vaapi: 'VAAPI (Intel/AMD on Linux)' };
const VIDEO: Record<string, string> = { h264: 'H.264', hevc: 'HEVC (H.265)', mpeg2video: 'MPEG-2' };
const AUDIO: Record<string, string> = { aac: 'AAC', ac3: 'AC-3 (Dolby Digital)', eac3: 'E-AC-3', mp3: 'MP3', libopus: 'Opus', copy: 'Copy the original' };
const ERROR_SCREENS: Record<string, string> = { pic: 'Picture', static: 'Static', blank: 'Blank', testsrc: 'Test pattern', text: 'Error text', kill: 'Stop the stream' };
const ERROR_AUDIO: Record<string, string> = { silent: 'Silence', sine: 'Tone', whitenoise: 'White noise' };
const DEFAULT_LOUDNORM = { i: -24, lra: 7, tp: -2 };
const EDITABLE = ['name', 'threadCount', 'hardwareAccelerationMode', 'resolution', 'videoFormat', 'videoBitDepth', 'videoBitRate', 'videoBufferSize', 'audioFormat', 'audioBitRate', 'audioBufferSize', 'audioChannels', 'audioSampleRate', 'audioVolumePercent', 'audioLoudnormConfig', 'normalizeFrameRate', 'deinterlaceVideo', 'disableChannelOverlay', 'errorScreen', 'errorScreenAudio', 'disableHardwareDecoder', 'disableHardwareEncoding', 'disableHardwareFilters'] as const;

export function TranscodeProfilesDialog({ onClose }: Props) {
  const [profiles, setProfiles] = useState<TranscodeProfile[] | null>(null);
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState<TranscodeProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback((select?: string) => tunarrApi.transcodeProfiles()
    .then((items) => {
      setProfiles(items);
      const pick = items.find((item) => item.id === select) ?? items.find((item) => item.isDefault) ?? items[0];
      if (pick) {
        setSelected(pick.id);
        setForm(structuredClone(pick));
      }
    })
    .catch((reason) => setError(errorText(reason))), []);
  useEffect(() => { void load(); }, [load]);

  const original = profiles?.find((item) => item.id === selected);
  const changes: Partial<TranscodeProfile> = {};
  if (form && original) for (const key of EDITABLE) if (JSON.stringify(form[key]) !== JSON.stringify(original[key])) (changes as Record<string, unknown>)[key] = form[key];
  const changed = Object.keys(changes).length > 0;
  const set = <K extends keyof TranscodeProfile>(key: K, value: TranscodeProfile[K]) => setForm((current) => (current ? { ...current, [key]: value } : current));
  const number = (key: keyof TranscodeProfile, label: string, min: number, max: number, step = 1, suffix = '') => (
    <label className="field"><span>{label}</span><span className="with-suffix"><input type="number" min={min} max={max} step={step} aria-label={label} value={Number(form?.[key] ?? 0)} onChange={(event) => set(key, Math.min(max, Math.max(min, Number(event.target.value))) as never)} />{suffix && <small>{suffix}</small>}</span></label>
  );
  const check = (key: keyof TranscodeProfile, label: string) => (
    <label><input type="checkbox" checked={!!form?.[key]} onChange={(event) => set(key, event.target.checked as never)} /> {label}</label>
  );

  const act = async (task: () => Promise<string | void>, done: string) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const select = await task();
      setMessage(done);
      await load(select || selected);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const resolutionKey = form?.resolution ? `${form.resolution.widthPx}x${form.resolution.heightPx}` : '';

  return (
    <div className="overlay" role="presentation">
      <section className="modal lists-modal transcode-modal" role="dialog" aria-modal="true" aria-labelledby="transcode-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="transcode-title">Transcode profiles</h2>
        <p className="subtle">How Tunarr encodes the video it streams. Channels pick a profile in Channel Settings → Streaming.</p>
        <div className="lists-layout">
          <div className="lists-index">
            <div className="candidate-list" role="listbox" aria-label="Transcode profiles">
              {profiles === null && !error && <p className="subtle candidate-empty">Loading…</p>}
              {profiles?.map((profile) => (
                <button key={profile.id} role="option" aria-selected={profile.id === selected} className={`list-entry ${profile.id === selected ? 'active' : ''}`} onClick={() => { setSelected(profile.id); setForm(structuredClone(profile)); setConfirmDelete(false); setMessage(''); }}>
                  <b>{profile.name}</b><small>{profile.isDefault ? 'Default · ' : ''}{profile.resolution ? `${profile.resolution.heightPx}p` : ''} {VIDEO[profile.videoFormat ?? ''] ?? ''}</small>
                </button>
              ))}
            </div>
          </div>
          <div className="lists-editor">
            {!form ? <p className="subtle">{error ? '' : 'Choose a profile.'}</p> : <>
              <div className="settings-grid">
                <label className="field"><span>Name</span><input aria-label="Profile name" value={form.name} onChange={(event) => set('name', event.target.value)} /></label>
                <label className="field"><span>Resolution</span><select aria-label="Resolution" value={resolutionKey} onChange={(event) => { const [widthPx, heightPx] = event.target.value.split('x').map(Number); set('resolution', { widthPx, heightPx }); }}>
                  {RESOLUTIONS.map(([width, height, label]) => <option key={`${width}x${height}`} value={`${width}x${height}`}>{label} ({width}×{height})</option>)}
                  {!RESOLUTIONS.some(([width, height]) => `${width}x${height}` === resolutionKey) && <option value={resolutionKey}>{resolutionKey.replace('x', '×')}</option>}
                </select></label>
                <label className="field"><span>Video codec</span><select aria-label="Video codec" value={form.videoFormat} onChange={(event) => set('videoFormat', event.target.value)}>{Object.entries(VIDEO).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="field"><span>Bit depth</span><select aria-label="Bit depth" value={String(form.videoBitDepth ?? 8)} onChange={(event) => set('videoBitDepth', Number(event.target.value))}><option value="8">8-bit</option><option value="10">10-bit</option></select></label>
                {number('videoBitRate', 'Video bitrate', 100, 200_000, 100, 'kbps')}
                {number('videoBufferSize', 'Video buffer', 100, 400_000, 100, 'kb')}
                <label className="field"><span>Hardware acceleration</span><select aria-label="Hardware acceleration" value={form.hardwareAccelerationMode} onChange={(event) => set('hardwareAccelerationMode', event.target.value)}>{Object.entries(HW).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                {number('threadCount', 'Encoder threads (0 = automatic)', 0, 128)}
                <label className="field"><span>Audio codec</span><select aria-label="Audio codec" value={form.audioFormat} onChange={(event) => set('audioFormat', event.target.value)}>{Object.entries(AUDIO).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                {number('audioBitRate', 'Audio bitrate', 16, 1536, 16, 'kbps')}
                {number('audioBufferSize', 'Audio buffer', 16, 6144, 16, 'kb')}
                {number('audioChannels', 'Audio channels', 1, 8)}
                {number('audioSampleRate', 'Sample rate', 8, 192, 1, 'kHz')}
                {number('audioVolumePercent', 'Volume', 0, 400, 5, '%')}
                <label className="field"><span>When a program fails</span><select aria-label="Error screen" value={form.errorScreen} onChange={(event) => set('errorScreen', event.target.value)}>{Object.entries(ERROR_SCREENS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label className="field"><span>Error audio</span><select aria-label="Error audio" value={form.errorScreenAudio} onChange={(event) => set('errorScreenAudio', event.target.value)}>{Object.entries(ERROR_AUDIO).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              </div>
              <div className="list-toolbar checks">
                <label><input type="checkbox" checked={!!form.audioLoudnormConfig} onChange={(event) => set('audioLoudnormConfig', event.target.checked ? DEFAULT_LOUDNORM : null)} /> Even out loudness</label>
                {check('normalizeFrameRate', 'Normalize frame rate')}
                {check('deinterlaceVideo', 'Deinterlace')}
                {check('disableChannelOverlay', 'No watermarks')}
                {form.hardwareAccelerationMode !== 'none' && <>{check('disableHardwareDecoder', 'Decode in software')}{check('disableHardwareEncoding', 'Encode in software')}{check('disableHardwareFilters', 'Filter in software')}</>}
              </div>
              {changed && <p className="subtle">Changes apply to every channel that uses “{original?.name}” the next time a stream starts.</p>}
              {message && <p className="subtle" role="status">{message}</p>}
              {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
              <div className="dialog-actions">
                {!form.isDefault && (confirmDelete
                  ? <><span className="subtle">Delete “{original?.name}”?</span><button onClick={() => setConfirmDelete(false)}>Keep</button><button className="primary" disabled={busy} onClick={() => void act(async () => { await tunarrApi.deleteTranscodeProfile(selected); return ''; }, 'Profile deleted.')}>Delete</button></>
                  : <button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete…</button>)}
                <button disabled={busy} onClick={() => void act(async () => (await tunarrApi.copyTranscodeProfile(selected)).id, 'Copied. You’re editing the copy.')}>Duplicate</button>
                <span className="spacer" />
                <button disabled={!changed || busy} onClick={() => original && setForm(structuredClone(original))}>Revert</button>
                <button className="primary" disabled={!changed || busy || !form.name.trim()} onClick={() => void act(async () => { await tunarrApi.saveTranscodeProfile(selected, changes); }, 'Profile saved.')}>{busy ? 'Saving…' : 'Save profile'}</button>
              </div>
            </>}
          </div>
        </div>
        {!form && error && <div className="warning" role="alert"><b>Couldn’t load</b><span>{error}</span></div>}
        <div className="dialog-actions"><button onClick={onClose}>{changed ? 'Close without saving' : 'Done'}</button></div>
      </section>
    </div>
  );
}
