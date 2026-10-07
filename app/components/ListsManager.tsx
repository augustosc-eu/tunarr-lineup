'use client';

import { useCallback, useEffect, useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import { FILLER_ROLES, guessRole, roleOf, ROLE_LABELS, ROLE_SPOT_LABELS, spotBreakdown, spotLength, type FillerRole, type FillerRoles } from '../../lib/fillerRoles';
import type { ContentProgram, ListSummary } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';
import { LibraryBrowser } from './LibraryBrowser';

type Props = {
  kind: 'filler' | 'custom';
  onClose: () => void;
  /** Called after any list is created, changed or deleted. */
  onChanged?: () => void;
  /** Filler only: the role Lineup keeps for each list (station IDs, commercials…). */
  roles?: FillerRoles;
  onRoleChange?: (listId: string, role: FillerRole | null) => Promise<void>;
  /** Filler only: open filtered to one role (Lists → Station IDs… / Commercials…). */
  initialRole?: FillerRole;
};

const TITLES: Partial<Record<FillerRole, string>> = { 'station-id': 'Station IDs', commercials: 'Commercials' };

type Editing = { id: string | null; name: string; programs: ContentProgram[]; loaded: boolean; synced: boolean };

const describe = (program: ContentProgram) => {
  type Meta = { title?: string; type?: string; show?: { title?: string }; episodeNumber?: number; program?: Meta };
  // Custom-show entries wrap the content program one level deeper.
  const outer = program.program as Meta | undefined;
  const meta = outer?.program && typeof outer.program === 'object' ? outer.program : outer;
  if (meta?.type === 'episode') return `${meta.show?.title ? `${meta.show.title} · ` : ''}${meta.episodeNumber != null ? `E${meta.episodeNumber} · ` : ''}${meta.title ?? ''}`;
  return meta?.title ?? 'Program';
};
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

export function ListsManager({ kind, onClose, onChanged, roles = {}, onRoleChange, initialRole }: Props) {
  const noun = kind === 'filler' ? (initialRole === 'station-id' ? 'station ID list' : initialRole === 'commercials' ? 'commercial list' : 'filler list') : 'custom show';
  const [filter, setFilter] = useState<FillerRole | 'all'>(kind === 'filler' && initialRole ? initialRole : 'all');
  // A new list's role is stored once Tunarr has given it an id.
  const [pendingRole, setPendingRole] = useState<FillerRole | ''>('');
  const [lists, setLists] = useState<ListSummary[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const loadLists = useCallback(() => {
    const request = kind === 'filler' ? tunarrApi.fillerLists() : tunarrApi.customShows();
    return request.then((items) => setLists([...items].sort((a, b) => a.name.localeCompare(b.name)))).catch((reason) => setError(errorText(reason)));
  }, [kind]);

  useEffect(() => { void loadLists(); }, [loadLists]);

  const select = async (list: ListSummary) => {
    setEditing({ id: list.id, name: list.name, programs: [], loaded: false, synced: list.synced });
    setDirty(false);
    setConfirmDelete(false);
    setError('');
    try {
      const programs = await (kind === 'filler' ? tunarrApi.fillerListPrograms(list.id) : tunarrApi.customShowPrograms(list.id));
      setEditing((current) => (current?.id === list.id ? { ...current, programs: programs.filter((program) => program.type === 'content' || program.type === 'custom'), loaded: true } : current));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const change = (patch: Partial<Editing>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
  };
  const move = (index: number, direction: -1 | 1) => {
    if (!editing) return;
    const target = index + direction;
    if (target < 0 || target >= editing.programs.length) return;
    const programs = [...editing.programs];
    [programs[index], programs[target]] = [programs[target], programs[index]];
    change({ programs });
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const programs = editing.programs.map((program) => ({ ...program, type: 'content' as const }));
      if (editing.id) {
        await (kind === 'filler' ? tunarrApi.updateFillerList(editing.id, { name: editing.name, programs }) : tunarrApi.updateCustomShow(editing.id, { name: editing.name, programs }));
      } else {
        const created = await (kind === 'filler' ? tunarrApi.createFillerList(editing.name, programs) : tunarrApi.createCustomShow(editing.name, programs));
        setEditing((current) => (current ? { ...current, id: created.id } : current));
        if (kind === 'filler' && pendingRole && onRoleChange) await onRoleChange(created.id, pendingRole).catch((reason) => setError(`The list was created, but its role wasn’t saved: ${errorText(reason)}`));
        setPendingRole('');
      }
      setDirty(false);
      await loadLists();
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    setBusy(true);
    try {
      await (kind === 'filler' ? tunarrApi.deleteFillerList(editing.id) : tunarrApi.deleteCustomShow(editing.id));
      setEditing(null);
      setConfirmDelete(false);
      await loadLists();
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const total = editing?.programs.reduce((sum, program) => sum + program.duration, 0) ?? 0;
  const shown = kind === 'filler' && filter !== 'all' ? lists?.filter((list) => roleOf(list, roles) === filter) : lists;
  const editingRole = editing?.id ? roles[editing.id] ?? '' : pendingRole;
  const changeRole = async (role: FillerRole | '') => {
    if (!editing) return;
    if (!editing.id) {
      setPendingRole(role);
      return;
    }
    if (!onRoleChange) return;
    setError('');
    try {
      await onRoleChange(editing.id, role || null);
    } catch (reason) {
      setError(errorText(reason));
    }
  };
  const canSave = !!editing && editing.name.trim().length > 0 && dirty && !busy && (kind !== 'filler' || editing.programs.length > 0);

  return (
    <div className="overlay" role="presentation" onKeyDown={(event) => {
      // Back closes the nested library browser without leaving the list being edited.
      if (browsing && (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack')) {
        event.stopPropagation();
        setBrowsing(false);
      }
    }}>
      <section className="modal lists-modal" role="dialog" aria-modal="true" aria-labelledby="lists-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">{kind === 'filler' ? 'FILLER LISTS' : 'CUSTOM SHOWS'}</p>
        <h2 id="lists-title">{kind === 'filler' ? (initialRole && TITLES[initialRole]) || 'Filler lists (commercials, bumpers, station IDs)' : 'Custom shows'}</h2>
        {kind === 'filler' && <div className="segmented role-filter" role="radiogroup" aria-label="Show lists for">
          {(['all', ...FILLER_ROLES] as const).map((role) => <button key={role} role="radio" aria-checked={filter === role} className={filter === role ? 'primary' : ''} onClick={() => setFilter(role)}>{role === 'all' ? 'All' : ROLE_LABELS[role]}</button>)}
        </div>}
        <div className="lists-layout">
          <div className="lists-index">
            <button className="wide primary" onClick={() => { setEditing({ id: null, name: '', programs: [], loaded: true, synced: false }); setPendingRole(filter === 'all' ? '' : filter); setDirty(true); setConfirmDelete(false); }}>New {noun}</button>
            <div className="candidate-list" role="listbox" aria-label={kind === 'filler' ? 'Filler lists' : 'Custom shows'}>
              {lists === null && <p className="subtle candidate-empty">Loading…</p>}
              {shown?.length === 0 && <p className="subtle candidate-empty">{lists?.length && filter !== 'all' ? `No lists tagged ${ROLE_LABELS[filter]} yet. Pick a list under All and set its role.` : 'None yet.'}</p>}
              {shown?.map((list) => {
                const role = kind === 'filler' ? roleOf(list, roles) : undefined;
                return (
                  <button key={list.id} role="option" aria-selected={editing?.id === list.id} className={`list-entry ${editing?.id === list.id ? 'active' : ''}`} onClick={() => void select(list)}>
                    <b>{list.name}</b><small>{role && <span className={`role-chip kind-${role === 'station-id' ? 'station-id' : role === 'commercials' ? 'commercial' : role === 'promos' ? 'promo' : role === 'bumpers' ? 'bumper' : 'filler'}`}>{ROLE_SPOT_LABELS[role]}{!roles[list.id] ? '?' : ''}</span>}{list.contentCount ?? '—'} items{list.synced ? ' · synced from Plex' : ''}</small>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="lists-editor">
            {!editing ? <p className="subtle">Choose a {noun} to edit, or create a new one.</p> : <>
              <label className="field"><span>Name</span><input aria-label="List name" value={editing.name} onChange={(event) => change({ name: event.target.value })} /></label>
              {kind === 'filler' && <label className="field"><span>On-air role</span>
                <select aria-label="On-air role" value={editingRole} disabled={!!editing.id && !onRoleChange} onChange={(event) => void changeRole(event.target.value as FillerRole | '')}>
                  <option value="">Not set{guessRole(editing.name) ? ` (looks like ${ROLE_LABELS[guessRole(editing.name)!]})` : ''}</option>
                  {FILLER_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
                </select>
                <small className="subtle">{editing.id ? 'Kept by Lineup, not Tunarr; saved as soon as you choose.' : 'Saved with the new list.'} Station IDs open commercial breaks; the day view marks each spot by its role.</small>
              </label>}
              {editing.synced && <div className="warning"><b>Synced from a Plex playlist</b><span>Tunarr may replace manual changes the next time it syncs this show.</span></div>}
              <div className="list-toolbar">
                <span>{editing.programs.length.toLocaleString('en')} {kind === 'filler' ? (editing.programs.length === 1 ? 'spot' : 'spots') : 'programs'} · {durationTimecode(total)}{kind === 'filler' && editing.programs.length > 0 && <small className="spot-mix"> · {spotBreakdown(editing.programs.map((program) => program.duration)).map((entry) => `${entry.count} × ${entry.length}`).join(', ')}</small>}</span>
                <button onClick={() => setBrowsing(true)}>Add programs…</button>
              </div>
              <div className="candidate-list list-items">
                {!editing.loaded && <p className="subtle candidate-empty">Loading programs…</p>}
                {editing.loaded && !editing.programs.length && <p className="subtle candidate-empty">No programs yet. Add some from your libraries.</p>}
                {editing.programs.map((program, index) => (
                  <div className="candidate" key={`${program.id}-${index}`}>
                    <span className="slot-index">{index + 1}</span>
                    <span><b>{describe(program)}</b><small>{kind === 'filler' ? `${spotLength(program.duration)} spot` : durationTimecode(program.duration)}</small></span>
                    <span className="candidate-actions">
                      {kind === 'custom' && <><button aria-label={`Move ${describe(program)} up`} disabled={index === 0} onClick={() => move(index, -1)}>↑</button><button aria-label={`Move ${describe(program)} down`} disabled={index === editing.programs.length - 1} onClick={() => move(index, 1)}>↓</button></>}
                      <button aria-label={`Remove ${describe(program)}`} onClick={() => change({ programs: editing.programs.filter((_, i) => i !== index) })}>Remove</button>
                    </span>
                  </div>
                ))}
              </div>
              {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
              <div className="dialog-actions">
                {editing.id && (confirmDelete
                  ? <><span className="subtle">Delete “{editing.name}”? Channels and slots using it will lose it.</span><button onClick={() => setConfirmDelete(false)}>Keep</button><button className="primary" disabled={busy} onClick={() => void remove()}>Delete</button></>
                  : <button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete…</button>)}
                <span className="spacer" />
                <button className="primary" disabled={!canSave} onClick={() => void save()}>{busy ? 'Saving…' : editing.id ? 'Save changes' : `Create ${noun}`}</button>
              </div>
            </>}
          </div>
        </div>
        {!editing && error && <div className="warning" role="alert"><b>Couldn’t load</b><span>{error}</span></div>}
        <div className="dialog-actions"><button onClick={onClose}>{dirty ? 'Close without saving' : 'Done'}</button></div>
      </section>
      {browsing && editing && <LibraryBrowser
        title={`Add to ${editing.name || `the new ${noun}`}`}
        mode="programs"
        confirmLabel="Add"
        onClose={() => setBrowsing(false)}
        onPick={(pick) => {
          if ('programs' in pick) change({ programs: [...editing.programs, ...pick.programs] });
          setBrowsing(false);
        }}
      />}
    </div>
  );
}
