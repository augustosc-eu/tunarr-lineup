'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { refusedParts, type PartBlocker } from '../../lib/compatibility';
import type { ListSummary } from '../../lib/library';
import { localVideoUrl, tunarrApi, uploadLocalVideo, type LocalVideoFolderView, type LocalVideosStatus, type LocalVideoSync } from '../../lib/tunarrClient';
import { VIDEO_KIND_LABELS, VIDEO_KINDS, type VideoKind } from '../../server/videoTitles';
import { dpadKey, keepFocusIn } from '../dpad';
import { MEDIA_COMPOSE_SNIPPET } from './FillerFoldersDialog';

type Props = {
  onClose: () => void;
  /** Custom shows were made or changed (the slot editor's catalog reloads). */
  onChanged: () => void;
  /** Why this Tunarr refuses adding folders, scanning or making shows, from the compatibility report. */
  blocked?: PartBlocker;
};

/** How often the open dialog checks Tunarr for finished scans. */
const PICK_UP_MS = 8000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const plural = (count: number, word: string) => `${count.toLocaleString('en')} ${word}${count === 1 ? '' : 's'}`;
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const scannedText = (tunarr: NonNullable<LocalVideoFolderView['tunarr']>) => (tunarr.scanning ? 'scanning…' : tunarr.lastScannedAt ? `scanned ${new Date(tunarr.lastScannedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : 'not scanned yet');
const KIND_HINTS: Record<VideoKind, string> = {
  'music-videos': 'Artists are read from “Artist - Title” file names; the show runs by artist.',
  videos: 'Downloads, web series, concerts: the show runs in file-name order (“Part 2” before “Part 10”).',
};

/** One line for what a pickup did, or '' when nothing changed. */
function syncText(sync: LocalVideoSync, shows: ListSummary[]) {
  const parts: string[] = [];
  for (const folder of sync.connected) parts.push(`Added “${folder}” to Tunarr.`);
  for (const made of sync.created) parts.push(`Made the custom show “${made.name}” (${plural(made.count, 'video')}).`);
  for (const updated of sync.updated) parts.push(`Updated “${shows.find((show) => show.id === updated.id)?.name ?? 'a custom show'}” (${plural(updated.count, 'video')}).`);
  return parts.join(' ');
}

/**
 * Local videos: music videos and downloaded videos that aren't in a media
 * server. They live in folders Tunarr reads as local sources: folders in
 * Lineup's media folder (uploaded here) or folders already on the Tunarr
 * server. A followed folder keeps a custom show of its videos, updated after
 * every Tunarr scan (server `syncLocalVideos`); the program bin groups music
 * videos by artist and spaces artists apart.
 */
export function LocalVideosDialog({ onClose, onChanged, blocked }: Props) {
  const noAdd = !!blocked?.('media-sources', 'create');
  const noScan = !!blocked?.('media-sources', 'scan');
  const noShow = !!blocked?.('custom-shows', 'create');
  const refusals = refusedParts(blocked, [['media-sources', 'create'], ['media-sources', 'scan'], ['custom-shows', 'create'], ['custom-shows', 'edit']]);
  const noPickUp = noAdd && noShow && !!blocked?.('custom-shows', 'edit');
  const [status, setStatus] = useState<LocalVideosStatus | null>(null);
  const [shows, setShows] = useState<ListSummary[]>([]);
  const [working, setWorking] = useState('');
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [syncSkipped, setSyncSkipped] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [playing, setPlaying] = useState('');
  const [newKind, setNewKind] = useState<VideoKind>('music-videos');
  const [newName, setNewName] = useState('');
  const [newFollow, setNewFollow] = useState(true);
  const [addKind, setAddKind] = useState<VideoKind>('videos');
  const [addPath, setAddPath] = useState('');
  const [addFollow, setAddFollow] = useState(true);
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const sectionRef = useRef<HTMLElement | null>(null);
  // Background pickup waits while an action runs, so the two don't race.
  const busy = useRef(false);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);
  useEffect(() => { sectionRef.current?.querySelector<HTMLElement>('select, input, button:not(.modal-close)')?.focus({ preventScroll: true }); }, []);

  const load = useCallback(() => Promise.all([tunarrApi.localVideos(), tunarrApi.customShows().catch(() => [] as ListSummary[])])
    .then(([found, customShows]) => {
      setStatus(found);
      setShows(customShows);
      return customShows;
    })
    .catch((reason) => { setError(errorText(reason)); return [] as ListSummary[]; }), []);

  const pickUp = useCallback(() => {
    if (busy.current) return Promise.resolve();
    if (noPickUp) return load().then(() => undefined);
    return tunarrApi.syncLocalVideos()
      .then(async (sync) => {
        const found = await load();
        setSyncErrors(sync.errors);
        setSyncSkipped(sync.skipped);
        const text = syncText(sync, found);
        if (text) {
          setMessage(text);
          changed.current();
        }
      })
      .catch(async (reason) => { setSyncErrors([errorText(reason)]); await load(); });
  }, [load, noPickUp]);

  useEffect(() => {
    void pickUp();
    if (noPickUp) return;
    const timer = window.setInterval(() => void pickUp(), PICK_UP_MS);
    return () => window.clearInterval(timer);
  }, [noPickUp, pickUp]);

  const run = async (key: string, task: () => Promise<string>) => {
    const previous = document.activeElement;
    busy.current = true;
    setWorking(key);
    setError('');
    setMessage('');
    let done = '';
    try {
      done = await task();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      busy.current = false;
      setWorking('');
      setProgress('');
      window.setTimeout(() => keepFocusIn(sectionRef.current, previous), 0);
    }
    await pickUp();
    if (done) setMessage((current) => (current && current !== done ? `${done} ${current}` : done));
  };

  const showOf = (folder: LocalVideoFolderView) => (folder.show ? shows.find((show) => show.id === folder.show!.id) : undefined);

  const scan = (folder: LocalVideoFolderView) => run(`scan-${folder.key}`, async () => {
    await tunarrApi.scanLibrary(folder.tunarr!.mediaSourceId, folder.tunarr!.libraryId);
    return `Tunarr is scanning “${folder.name}”.${folder.show || folder.pending ? ' Its custom show follows when the scan is done.' : ''}`;
  });

  const follow = (folder: LocalVideoFolderView, on: boolean) => run(`follow-${folder.key}`, async () => {
    const result = await tunarrApi.setVideoLibrary(folder.tunarr!.libraryId, { follow: on });
    if (!on) return `“${folder.name}” isn’t followed any more. Its custom show stays in Tunarr as it is.`;
    if (result.show) {
      onChanged();
      return `Made a custom show of “${folder.name}” with ${plural(result.show.count, 'video')}. It follows the folder from now on.${result.show.storeError ? ` ${result.show.storeError}` : ''}`;
    }
    return `“${folder.name}” gets its custom show after Tunarr’s scan.`;
  });

  const changeKind = (folder: LocalVideoFolderView, kind: VideoKind) => run(`kind-${folder.key}`, async () => {
    await tunarrApi.setVideoLibrary(folder.tunarr!.libraryId, { kind });
    return `“${folder.name}” holds ${VIDEO_KIND_LABELS[kind].toLowerCase()}.${folder.show ? ' Its show is put in that order after the next scan.' : ''}`;
  });

  const upload = (folder: LocalVideoFolderView, files: File[]) => run(`upload-${folder.key}`, async () => {
    const kind = folder.upload!.area;
    let done = 0;
    for (const file of files) {
      setProgress(`Uploading ${file.name} (${done + 1} of ${files.length})…`);
      await uploadLocalVideo(kind, folder.upload!.folder, file, (fraction) => setProgress(`Uploading ${file.name} (${done + 1} of ${files.length}) · ${Math.round(fraction * 100)}%`));
      done += 1;
    }
    // New files reach the show once Tunarr has scanned them; pickup does the rest.
    if (folder.tunarr && !noScan) await tunarrApi.scanLibrary(folder.tunarr.mediaSourceId, folder.tunarr.libraryId).catch(() => undefined);
    return `Uploaded ${plural(done, 'video')} to “${folder.name}”.${folder.show || folder.pending ? ' Its custom show picks them up after Tunarr’s scan.' : ''}`;
  });

  const makeFolder = () => run('make-folder', async () => {
    const name = newName.trim();
    const made = await tunarrApi.makeVideoFolder(newKind, name, newFollow);
    setNewName('');
    return `Made the folder “${made.folder}” in ${VIDEO_KIND_LABELS[newKind]}.${made.tunarrError ? ` ${made.tunarrError}` : ` Tunarr reads it from now on${newFollow ? '; its custom show is made once videos are scanned' : ''}.`} Upload videos into it below.`;
  });

  const addFolder = () => run('add-folder', async () => {
    const path = addPath.trim();
    const added = await tunarrApi.addVideoFolder(addKind, path, addFollow);
    setAddPath('');
    return `${added.existing ? 'Tunarr already reads' : 'Added'} ${path}.${addFollow ? ' Its custom show is made after Tunarr’s scan.' : ''}`;
  });

  const onKeyDown = (event: KeyboardEvent) => { dpadKey(event, sectionRef.current); };

  const folderRow = (folder: LocalVideoFolderView) => {
    const show = showOf(folder);
    const kindOfUpload = folder.upload?.area;
    const where = folder.upload ? `Lineup media folder · ${plural(folder.upload.files.length, 'video')}` : `${folder.tunarr?.source ?? 'Tunarr'} · on the Tunarr server`;
    const showText = show ? `→ “${show.name}”${show.contentCount !== undefined ? ` (${plural(show.contentCount, 'video')})` : ''}` : folder.show ? '→ its custom show' : folder.pending ? '→ a custom show after its scan' : '';
    return (
      <div className="source-block" key={folder.key}>
        <div className="source-head">
          <b>{folder.name}</b><small>{where} · {folder.tunarr ? scannedText(folder.tunarr) : 'not in Tunarr yet'}</small>
          <span className="spacer" />
          {showText && <small>{showText}</small>}
          {folder.upload && <>
            <input type="file" accept="video/*,.mkv,.ts,.m2ts" multiple hidden aria-label={`Upload to ${folder.name}`} ref={(element) => { inputs.current[folder.key] = element; }}
              onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void upload(folder, files); }} />
            <button disabled={!!working} onClick={() => inputs.current[folder.key]?.click()}>{working === `upload-${folder.key}` ? 'Uploading…' : 'Upload videos…'}</button>
          </>}
          {folder.tunarr && <>
            <select aria-label={`What ${folder.name} holds`} value={folder.kind} disabled={!!working} onChange={(event) => void changeKind(folder, event.target.value as VideoKind)}>
              {VIDEO_KINDS.map((kind) => <option key={kind} value={kind}>{VIDEO_KIND_LABELS[kind]}</option>)}
            </select>
            <button disabled={!!working || noScan} onClick={() => void scan(folder)}>{working === `scan-${folder.key}` ? 'Starting…' : 'Scan now'}</button>
            {folder.show || folder.pending
              ? <button disabled={!!working} onClick={() => void follow(folder, false)}>{working === `follow-${folder.key}` ? 'Stopping…' : 'Stop following'}</button>
              : <button className="primary" disabled={!!working || noShow} onClick={() => void follow(folder, true)}>{working === `follow-${folder.key}` ? 'Reading…' : 'Keep a custom show'}</button>}
          </>}
        </div>
        {folder.upload && folder.upload.files.length > 0 && kindOfUpload && <details className="other-libraries">
          <summary>Files ({folder.upload.files.length})</summary>
          {folder.upload.files.map((file) => {
            const key = `${folder.key}/${file.name}`;
            return (
              <div className="candidate file-row" key={key}>
                <span><b>{file.name}</b><small>{size(file.size)}</small></span>
                <button aria-label={`${playing === key ? 'Stop' : 'Play'} ${file.name}`} aria-pressed={playing === key} onClick={() => setPlaying((current) => (current === key ? '' : key))}>{playing === key ? 'Stop' : 'Play'}</button>
                {playing === key && <video className="clip-preview" src={localVideoUrl(kindOfUpload, folder.upload!.folder, file.name)} controls autoPlay playsInline aria-label={`Preview of ${file.name}`} onEnded={() => setPlaying('')} />}
                {confirmDelete === key
                  ? <span className="candidate-actions"><button onClick={() => setConfirmDelete('')}>Keep</button><button className="primary" disabled={!!working} onClick={() => void run(`delete-${key}`, async () => { await tunarrApi.deleteLocalVideo(kindOfUpload, folder.upload!.folder, file.name); setConfirmDelete(''); return `Deleted ${file.name}.${folder.show ? ' Its custom show drops it after Tunarr’s next scan.' : ''}`; })}>Delete file</button></span>
                  : <span className="candidate-actions"><button disabled={!!working} aria-label={`Delete ${file.name}`} onClick={() => setConfirmDelete(key)}>Delete…</button></span>}
              </div>
            );
          })}
        </details>}
      </div>
    );
  };

  const media = status?.media;
  const folders = status?.folders ?? [];

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} className="modal lists-modal folders-modal local-videos-modal" role="dialog" aria-modal="true" aria-labelledby="local-videos-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="local-videos-title">Local videos</h2>
        {refusals.length > 0 && <div className="warning" role="note"><b>Not on this Tunarr</b>{refusals.map((reason) => <span key={reason}>{reason}</span>)}</div>}
        <p className="subtle">Music videos and downloaded videos that aren’t in Plex, Jellyfin or Emby. Keep them in folders Tunarr reads: make folders here and upload into them, or add folders already on the Tunarr server. Each folder can keep a <b>custom show</b> of its videos, updated after every Tunarr scan, for slot schedules and the lineup. In the program bin, <b>Group by artist</b> and <b>Shuffle, artists apart</b> build music-video blocks.</p>
        {status?.tunarrError && <div className="warning"><b>Tunarr</b><span>{status.tunarrError}</span></div>}

        {VIDEO_KINDS.map((kind) => {
          const own = folders.filter((folder) => folder.kind === kind);
          return (
            <div key={kind}>
              <h3 className="section-title">{VIDEO_KIND_LABELS[kind]}</h3>
              <p className="subtle">{KIND_HINTS[kind]}</p>
              <div className="candidate-list folders-list">
                {status !== null && !own.length && <p className="subtle candidate-empty">No {VIDEO_KIND_LABELS[kind].toLowerCase()} folders yet. Make one below, or add a folder on the Tunarr server.</p>}
                {own.map(folderRow)}
              </div>
            </div>
          );
        })}
        {status === null && !error && <p className="subtle">Loading…</p>}

        <h3 className="section-title">New folder in Lineup’s media folder</h3>
        {media && !media.enabled && <div className="media-setup">
          <p className="subtle">{media.message} In Docker, first give Lineup and Tunarr one shared folder: add these lines to docker-compose.yml, run <code>docker compose up -d</code>, then choose <code>/media/lineup</code> there. You can still add folders on the Tunarr server below.</p>
          <pre aria-label="docker-compose.yml lines for the media folder" tabIndex={0}>{MEDIA_COMPOSE_SNIPPET}</pre>
        </div>}
        {media?.enabled && <>
          <div className="settings-grid add-folder">
            <label className="field"><span>Holds</span><select aria-label="New folder holds" value={newKind} onChange={(event) => setNewKind(event.target.value as VideoKind)}>{VIDEO_KINDS.map((kind) => <option key={kind} value={kind}>{VIDEO_KIND_LABELS[kind]}</option>)}</select></label>
            <label className="field wide-field"><span>Folder name</span><input aria-label="New folder name" value={newName} maxLength={100} placeholder={newKind === 'music-videos' ? '80s Rock' : 'Concerts'} onChange={(event) => setNewName(event.target.value)} /></label>
            <button disabled={!newName.trim() || !!working} onClick={() => void makeFolder()}>{working === 'make-folder' ? 'Making…' : 'Make folder'}</button>
          </div>
          <label className="keep-on-air"><input type="checkbox" checked={newFollow} onChange={(event) => setNewFollow(event.target.checked)} /> Keep a custom show of it</label>
          <p className="subtle">Video files up to {Math.round(media.maxBytes / 1024 ** 2)} MB. Deleting a file removes it from the disk.</p>
        </>}

        <h3 className="section-title">Add a folder on the Tunarr server</h3>
        <div className="settings-grid add-folder">
          <label className="field"><span>Holds</span><select aria-label="Server folder holds" value={addKind} onChange={(event) => setAddKind(event.target.value as VideoKind)}>{VIDEO_KINDS.map((kind) => <option key={kind} value={kind}>{VIDEO_KIND_LABELS[kind]}</option>)}</select></label>
          <label className="field wide-field"><span>Folder on the Tunarr server</span><input aria-label="Server folder path" value={addPath} placeholder="/media/downloads/concerts" onChange={(event) => setAddPath(event.target.value)} /></label>
          <button disabled={!addPath.trim() || !!working || noAdd} onClick={() => void addFolder()}>{working === 'add-folder' ? 'Adding…' : 'Add folder'}</button>
        </div>
        <label className="keep-on-air"><input type="checkbox" checked={addFollow} onChange={(event) => setAddFollow(event.target.checked)} /> Keep a custom show of it</label>

        {progress && <p className="subtle" role="status">{progress}</p>}
        {message && !progress && <p className="subtle" role="status">{message}</p>}
        {syncErrors.length > 0 && <div className="warning"><b>Pickup</b><span>{syncErrors.join(' ')}</span></div>}
        {syncSkipped.length > 0 && <div className="warning"><b>Left out of pickup</b>{syncSkipped.map((line) => <span key={line}>{line}</span>)}</div>}
        {error && <div className="warning" role="alert"><b>Something went wrong</b><span>{error}</span></div>}
        <div className="dialog-actions"><span className="spacer" /><button onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
