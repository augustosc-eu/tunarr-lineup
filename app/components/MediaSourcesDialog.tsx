'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ManagedSource, NewMediaSource } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';

type Props = { onClose: () => void };
type Kind = NewMediaSource['type'];

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const KIND_LABELS: Record<string, string> = { plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', local: 'Local folders' };
const MEDIA_TYPES: Array<[string, string]> = [['movies', 'Movies'], ['shows', 'TV shows'], ['music_videos', 'Music videos'], ['other_videos', 'Other videos'], ['tracks', 'Music']];
const scanned = (ms?: number) => (ms ? `scanned ${new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : 'not scanned yet');

function AddSourceForm({ onAdded, onCancel }: { onAdded: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>('plex');
  const [name, setName] = useState('');
  const [uri, setUri] = useState('');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mediaType, setMediaType] = useState('movies');
  const [paths, setPaths] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const body = (): NewMediaSource => {
    if (kind === 'plex') return { type: 'plex', name: name.trim(), uri: uri.trim(), accessToken: token.trim() };
    if (kind === 'local') return { type: 'local', name: name.trim(), mediaType, paths: paths.split('\n').map((path) => path.trim()).filter(Boolean) };
    return { type: kind, name: name.trim(), uri: uri.trim(), username: username.trim(), password };
  };
  const add = async () => {
    setBusy(true);
    setError('');
    try {
      await tunarrApi.addMediaSource(body());
      setPassword('');
      setToken('');
      onAdded();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const ready = name.trim() && (kind === 'local' ? paths.trim() : uri.trim() && (kind === 'plex' ? token.trim() : username.trim() && password));

  return (
    <div className="add-source">
      <h3 className="section-title">Add a media source</h3>
      <div className="settings-grid">
        <label className="field"><span>Type</span><select aria-label="Source type" value={kind} onChange={(event) => setKind(event.target.value as Kind)}>{Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>Name</span><input aria-label="Source name" value={name} placeholder={kind === 'local' ? 'Home movies' : 'Living-room server'} onChange={(event) => setName(event.target.value)} /></label>
        {kind !== 'local' && <label className="field wide-field"><span>Server address (as Tunarr reaches it)</span><input aria-label="Server address" value={uri} placeholder={kind === 'plex' ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096'} onChange={(event) => setUri(event.target.value)} /></label>}
        {kind === 'plex' && <label className="field wide-field"><span>Plex token (X-Plex-Token)</span><input aria-label="Plex token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></label>}
        {(kind === 'jellyfin' || kind === 'emby') && <>
          <label className="field"><span>User name</span><input aria-label="User name" autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label className="field"><span>Password</span><input aria-label="Password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        </>}
        {kind === 'local' && <>
          <label className="field"><span>The folders contain</span><select aria-label="Folder contents" value={mediaType} onChange={(event) => setMediaType(event.target.value)}>{MEDIA_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="field wide-field"><span>Folders on the Tunarr server (one per line)</span><textarea aria-label="Folders" rows={3} value={paths} placeholder="/media/movies" onChange={(event) => setPaths(event.target.value)} /></label>
        </>}
      </div>
      <p className="subtle">
        {kind === 'plex' && 'Find the token in Plex Web: open any item, choose Get Info → View XML, and copy the X-Plex-Token value from the address. '}
        {(kind === 'jellyfin' || kind === 'emby') && 'Tunarr signs in once and keeps an access token. Lineup doesn’t store the password. '}
        Tunarr connects to the server; Lineup never shows its address or token again.
      </p>
      {error && <div className="warning" role="alert"><b>Not added</b><span>{error}</span></div>}
      <div className="dialog-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!ready || busy} onClick={() => void add()}>{busy ? 'Adding…' : 'Add source'}</button></div>
    </div>
  );
}

export function MediaSourcesDialog({ onClose }: Props) {
  const [sources, setSources] = useState<ManagedSource[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  // Library switches flip right away; the list reloads once Tunarr has answered.
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const load = useCallback(() => tunarrApi.managedSources().then(setSources).catch((reason) => setError(errorText(reason))), []);
  useEffect(() => { void load(); }, [load]);

  const run = async (key: string, task: () => Promise<unknown>, done: string) => {
    setWorking(key);
    setError('');
    setMessage('');
    try {
      await task();
      setMessage(done);
      await load();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setWorking('');
    }
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal lists-modal sources-modal" role="dialog" aria-modal="true" aria-labelledby="sources-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="sources-title">Media sources</h2>
        <p className="subtle">Where Tunarr finds programs. Turn on the libraries channels should draw from; Tunarr scans them so they appear in Insert, filler lists and slot sources.</p>
        <div className="candidate-list sources-list">
          {sources === null && !error && <p className="subtle candidate-empty">Loading…</p>}
          {sources?.length === 0 && <p className="subtle candidate-empty">No media sources yet.</p>}
          {sources?.map((source) => (
            <div className="source-block" key={source.id}>
              <div className="source-head">
                <b>{source.name}</b><small>{KIND_LABELS[source.type ?? ''] ?? source.type}</small>
                <span className="spacer" />
                {source.type !== 'local' && <button disabled={!!working} onClick={() => void run(`refresh-${source.id}`, () => tunarrApi.refreshMediaSource(source.id), `Re-read ${source.name}’s libraries.`)}>{working === `refresh-${source.id}` ? 'Refreshing…' : 'Refresh libraries'}</button>}
                {confirmDelete === source.id
                  ? <><span className="subtle">Remove {source.name} and its programs from Tunarr?</span><button onClick={() => setConfirmDelete('')}>Keep</button><button className="primary" disabled={!!working} onClick={() => void run(`delete-${source.id}`, async () => { await tunarrApi.deleteMediaSource(source.id); setConfirmDelete(''); }, `Removed ${source.name}.`)}>Remove</button></>
                  : <button disabled={!!working} onClick={() => setConfirmDelete(source.id)}>Remove…</button>}
              </div>
              {source.libraries.length === 0 && <p className="subtle">{source.type === 'local' ? 'Folders are scanned automatically.' : 'No libraries yet. Refresh to read them from the server.'}</p>}
              {source.libraries.map((library) => (
                <div className="candidate library-row" key={library.id}>
                  <label><input type="checkbox" checked={pending[library.id] ?? library.enabled} disabled={!!working} aria-label={`Use library ${library.name}`}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      setPending((current) => ({ ...current, [library.id]: enabled }));
                      void run(`lib-${library.id}`, () => tunarrApi.setLibraryEnabled(source.id, library.id, enabled), enabled ? `Turned on ${library.name}; Tunarr is scanning it.` : `Turned off ${library.name}.`)
                        .finally(() => setPending((current) => { const next = { ...current }; delete next[library.id]; return next; }));
                    }} /> <b>{library.name}</b></label>
                  <small>{library.mediaType ?? ''} · {library.enabled ? scanned(library.lastScannedAt) : 'off'}{library.isLocked ? ' · scanning…' : ''}</small>
                  {library.enabled && <button disabled={!!working} onClick={() => void run(`scan-${library.id}`, () => tunarrApi.scanLibrary(source.id, library.id), `Scanning ${library.name}.`)}>Scan now</button>}
                </div>
              ))}
            </div>
          ))}
        </div>
        {message && <p className="subtle" role="status">{message}</p>}
        {error && <div className="warning" role="alert"><b>Something went wrong</b><span>{error}</span></div>}
        {adding ? <AddSourceForm onCancel={() => setAdding(false)} onAdded={() => { setAdding(false); setMessage('Media source added. Turn on the libraries you want.'); void load(); }} />
          : <div className="dialog-actions"><button className="primary" onClick={() => setAdding(true)}>Add media source…</button><span className="spacer" /><button onClick={onClose}>Done</button></div>}
      </section>
    </div>
  );
}
