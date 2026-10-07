'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { FILLER_ROLES, folderRole, ROLE_LABELS, type FillerRole, type FillerRoles } from '../../lib/fillerRoles';
import type { ListSummary, ManagedSource } from '../../lib/library';
import { tunarrApi, uploadMediaFile, type FillerSync, type MediaFolderStatus } from '../../lib/tunarrClient';
import type { FillerFolders } from '../../server/fillerRoles';

type Props = { roles: FillerRoles; onClose: () => void; onChanged: () => void };
type Folder = { mediaSourceId: string; libraryId: string; name: string; source?: string; scanned?: number; scanning?: boolean };

/** How often the open dialog checks Tunarr for finished scans. */
const PICK_UP_MS = 8000;
const NO_FOLDERS: FillerFolders = { links: {}, pending: {}, ignored: [] };

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const scannedText = (folder: Folder) => (folder.scanning ? 'scanning…' : folder.scanned ? `scanned ${new Date(folder.scanned).toLocaleDateString('en', { month: 'short', day: 'numeric' })}` : 'not scanned yet');
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** One line for what a sync picked up, or '' when nothing changed. */
function syncText(sync: FillerSync, lists: ListSummary[]) {
  const parts: string[] = [];
  if (sync.connected) parts.push('Added the upload folder to Tunarr.');
  for (const made of sync.created) parts.push(`Made “${made.name}” (${plural(made.count, 'video')}).`);
  for (const updated of sync.updated) parts.push(`Updated “${lists.find((list) => list.id === updated.id)?.name ?? 'a list'}” (${plural(updated.count, 'video')}).`);
  return parts.join(' ');
}

/**
 * Filler folders: video files for station IDs, commercials, promos and bumpers,
 * kept in folders Tunarr reads. Lineup picks them up by itself (server
 * `syncFillerFolders`): the upload folder (LINEUP_MEDIA_DIR) is added to Tunarr,
 * every folder named for a role gets a filler list with that role, and lists
 * follow their folder after each scan. Libraries with no obvious role get a
 * one-time "Make filler list".
 */
export function FillerFoldersDialog({ roles, onClose, onChanged }: Props) {
  const [status, setStatus] = useState<MediaFolderStatus | null>(null);
  const [sources, setSources] = useState<ManagedSource[] | null>(null);
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [folders, setFolders] = useState<FillerFolders>(NO_FOLDERS);
  const [working, setWorking] = useState('');
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [syncErrors, setSyncErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState('');
  const [folderRoles, setFolderRoles] = useState<Record<string, FillerRole>>({});
  const [newRole, setNewRole] = useState<FillerRole>('commercials');
  const [newPath, setNewPath] = useState('');
  const inputs = useRef<Partial<Record<FillerRole, HTMLInputElement | null>>>({});
  // Background pickup waits while an action runs, so the two don't race.
  const busy = useRef(false);
  const changed = useRef(onChanged);
  useEffect(() => { changed.current = onChanged; }, [onChanged]);

  const load = useCallback(() => Promise.all([tunarrApi.mediaFolder(), tunarrApi.managedSources(), tunarrApi.fillerLists(), tunarrApi.fillerFolders().catch(() => NO_FOLDERS)])
    .then(([folder, managed, found, followed]) => {
      setStatus(folder);
      setSources(managed);
      setLists(found);
      setFolders(followed);
      return found;
    })
    .catch((reason) => { setError(errorText(reason)); return [] as ListSummary[]; }), []);

  const pickUp = useCallback(() => {
    if (busy.current) return Promise.resolve();
    return tunarrApi.syncFillerFolders()
      .then(async (sync) => {
        const found = await load();
        setSyncErrors(sync.errors);
        const text = syncText(sync, found);
        if (text) {
          setMessage(text);
          changed.current();
        }
      })
      .catch(async (reason) => { setSyncErrors([errorText(reason)]); await load(); });
  }, [load]);

  useEffect(() => {
    void pickUp();
    const timer = window.setInterval(() => void pickUp(), PICK_UP_MS);
    return () => window.clearInterval(timer);
  }, [pickUp]);

  const run = async (key: string, task: () => Promise<string>) => {
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
    }
    await pickUp();
    // The action's own message wins over a quiet pickup.
    if (done) setMessage((current) => (current && current !== done ? `${done} ${current}` : done));
  };

  const listFor = (libraryId: string) => {
    const id = Object.keys(folders.links).find((listId) => folders.links[listId].libraryId === libraryId);
    return id ? lists.find((list) => list.id === id) : undefined;
  };

  const scan = (folder: Folder) => run(`scan-${folder.libraryId}`, async () => {
    await tunarrApi.scanLibrary(folder.mediaSourceId, folder.libraryId);
    return `Tunarr is scanning ${folder.name}. Its list follows when the scan is done.`;
  });

  const makeList = (folder: Folder, role: FillerRole) => run(`list-${folder.libraryId}`, async () => {
    const name = `${ROLE_LABELS[role]} – ${lastSegment(folder.name)}`;
    const made = await tunarrApi.fillerListFromLibrary({ mediaSourceId: folder.mediaSourceId, libraryId: folder.libraryId, name, role });
    onChanged();
    return `Made the filler list “${name}” with ${plural(made.count, 'video')}. It follows the folder from now on.${made.storeError ? ` ${made.storeError}` : ''}`;
  });

  const upload = (role: FillerRole, files: File[], folder: Folder | null) => run(`upload-${role}`, async () => {
    let done = 0;
    for (const file of files) {
      setProgress(`Uploading ${file.name} (${done + 1} of ${files.length})…`);
      await uploadMediaFile(role, file, (fraction) => setProgress(`Uploading ${file.name} (${done + 1} of ${files.length}) · ${Math.round(fraction * 100)}%`));
      done += 1;
    }
    // New files reach the list once Tunarr has scanned them; pickup does the rest.
    if (folder) await tunarrApi.scanLibrary(folder.mediaSourceId, folder.libraryId).catch(() => undefined);
    return `Uploaded ${plural(done, 'video')} to ${ROLE_LABELS[role]}. The list picks them up after Tunarr’s scan.`;
  });

  const uploaded = status?.enabled ? status.folders : [];
  const uploadLibraries = new Set(uploaded.map((folder) => folder.tunarr?.libraryId).filter(Boolean));
  const tunarrFolders: Folder[] = (sources ?? []).flatMap((source) => source.libraries
    .filter((library) => library.enabled && !uploadLibraries.has(library.id))
    .map((library) => ({ mediaSourceId: source.id, libraryId: library.id, name: library.name, source: source.name, scanned: library.lastScannedAt, scanning: library.isLocked })));
  // Followed: has a list, is waiting for its first scan, or is plainly named for a role.
  const autoRole = (folder: Folder) => folders.pending[folder.libraryId]?.role ?? (folders.ignored.includes(folder.libraryId) ? undefined : folderRole(folder.name));
  const followed = tunarrFolders.filter((folder) => listFor(folder.libraryId) || autoRole(folder));
  const others = tunarrFolders.filter((folder) => !followed.includes(folder));

  const followedRow = (folder: Folder) => {
    const list = listFor(folder.libraryId);
    const role = (list && roles[list.id]) || autoRole(folder);
    return (
      <div className="source-block" key={folder.libraryId}>
        <div className="source-head">
          <b>{folder.name}</b><small>{folder.source} · {scannedText(folder)}</small>
          <span className="spacer" />
          <small>{list ? `→ “${list.name}”${role ? ` (${ROLE_LABELS[role]})` : ''}` : `→ a ${role ? ROLE_LABELS[role] : 'filler'} list after its scan`}</small>
          <button disabled={!!working} onClick={() => void scan(folder)}>{working === `scan-${folder.libraryId}` ? 'Starting…' : 'Scan now'}</button>
        </div>
      </div>
    );
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal lists-modal folders-modal" role="dialog" aria-modal="true" aria-labelledby="folders-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="folders-title">Filler folders</h2>
        <p className="subtle">Keep station IDs, commercials, promos and bumpers as video files in folders. Lineup picks them up by itself: the upload folder, folders you add here, and any Tunarr library named for a role (“Commercials”, “station-ids”). Each becomes a filler list with its role, and the list follows its folder after every Tunarr scan.</p>

        <h3 className="section-title">Upload folder</h3>
        {status === null && !error && <p className="subtle">Loading…</p>}
        {status && !status.enabled && <p className="subtle">{status.message} The folder must also be mounted into Tunarr; see the README.</p>}
        {status?.enabled && <>
          {status.tunarrError && <div className="warning"><b>Tunarr</b><span>{status.tunarrError}</span></div>}
          <div className="candidate-list folders-list">
            {status.folders.map((folder) => {
              const linked: Folder | null = folder.tunarr ? { ...folder.tunarr, name: ROLE_LABELS[folder.role], scanned: folder.tunarr.lastScannedAt } : null;
              const list = linked ? listFor(linked.libraryId) : undefined;
              return (
                <div className="source-block" key={folder.role}>
                  <div className="source-head">
                    <b>{ROLE_LABELS[folder.role]}</b><small>{plural(folder.files.length, 'video')} · folder “{folder.folder}”{linked ? ` · ${scannedText(linked)}` : ' · not in Tunarr yet'}{list ? ` · → “${list.name}”` : ''}</small>
                    <span className="spacer" />
                    <input type="file" accept="video/*,.mkv,.ts,.m2ts" multiple hidden aria-label={`Upload to ${ROLE_LABELS[folder.role]}`} ref={(element) => { inputs.current[folder.role] = element; }}
                      onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; if (files.length) void upload(folder.role, files, linked); }} />
                    <button disabled={!!working} onClick={() => inputs.current[folder.role]?.click()}>{working === `upload-${folder.role}` ? 'Uploading…' : 'Upload videos…'}</button>
                    {linked && <button disabled={!!working} onClick={() => void scan(linked)}>{working === `scan-${linked.libraryId}` ? 'Starting…' : 'Scan now'}</button>}
                  </div>
                  {folder.files.map((file) => {
                    const key = `${folder.role}/${file.name}`;
                    return (
                      <div className="candidate file-row" key={key}>
                        <span><b>{file.name}</b><small>{size(file.size)}</small></span>
                        <select aria-label={`Move ${file.name} to`} value={folder.role} disabled={!!working}
                          onChange={(event) => { const to = event.target.value as FillerRole; void run(`move-${key}`, async () => { await tunarrApi.moveMediaFile(folder.role, file.name, to); return `Moved ${file.name} to ${ROLE_LABELS[to]}. Both lists follow after Tunarr’s next scan.`; }); }}>
                          {FILLER_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                        </select>
                        {confirmDelete === key
                          ? <span className="candidate-actions"><button onClick={() => setConfirmDelete('')}>Keep</button><button className="primary" disabled={!!working} onClick={() => void run(`delete-${key}`, async () => { await tunarrApi.deleteMediaFile(folder.role, file.name); setConfirmDelete(''); return `Deleted ${file.name}.`; })}>Delete file</button></span>
                          : <span className="candidate-actions"><button disabled={!!working} aria-label={`Delete ${file.name}`} onClick={() => setConfirmDelete(key)}>Delete…</button></span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <p className="subtle">Video files up to {Math.round(status.maxBytes / 1024 ** 2)} MB. Moving a file between roles keeps it; deleting removes it from the disk.</p>
        </>}

        <h3 className="section-title">Folders and libraries in Tunarr</h3>
        <div className="candidate-list folders-list">
          {sources !== null && !followed.length && <p className="subtle candidate-empty">No filler folders found yet. Add one below, or name a Tunarr library for its role.</p>}
          {followed.map(followedRow)}
        </div>
        {others.length > 0 && (
          <details className="other-libraries">
            <summary>Other libraries ({others.length})</summary>
            <div className="candidate-list folders-list">
              {others.map((folder) => {
                const role = folderRoles[folder.libraryId] ?? 'commercials';
                return (
                  <div className="source-block" key={folder.libraryId}>
                    <div className="source-head">
                      <b>{folder.name}</b><small>{folder.source} · {scannedText(folder)}</small>
                      <span className="spacer" />
                      <select aria-label={`Role for ${folder.name}`} value={role} disabled={!!working} onChange={(event) => setFolderRoles((current) => ({ ...current, [folder.libraryId]: event.target.value as FillerRole }))}>
                        {FILLER_ROLES.map((item) => <option key={item} value={item}>{ROLE_LABELS[item]}</option>)}
                      </select>
                      <button className="primary" disabled={!!working} onClick={() => void makeList(folder, role)}>{working === `list-${folder.libraryId}` ? 'Reading…' : 'Make filler list'}</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        )}
        <div className="settings-grid add-folder">
          <label className="field"><span>Role</span><select aria-label="New folder role" value={newRole} onChange={(event) => setNewRole(event.target.value as FillerRole)}>{FILLER_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label>
          <label className="field wide-field"><span>Folder on the Tunarr server</span><input aria-label="Folder path" value={newPath} placeholder="/media/commercials" onChange={(event) => setNewPath(event.target.value)} /></label>
          <button disabled={!newPath.trim() || !!working} onClick={() => void run('add-folder', async () => {
            const path = newPath.trim();
            await tunarrApi.addFillerFolder(path, newRole);
            setNewPath('');
            return `Added ${path}. Its ${ROLE_LABELS[newRole]} list appears after Tunarr’s scan.`;
          })}>{working === 'add-folder' ? 'Adding…' : 'Add folder'}</button>
        </div>

        {progress && <p className="subtle" role="status">{progress}</p>}
        {message && !progress && <p className="subtle" role="status">{message}</p>}
        {syncErrors.length > 0 && <div className="warning"><b>Pickup</b><span>{syncErrors.join(' ')}</span></div>}
        {error && <div className="warning" role="alert"><b>Something went wrong</b><span>{error}</span></div>}
        <div className="dialog-actions"><span className="spacer" /><button onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
