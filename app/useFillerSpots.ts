'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ListSpots, SpotIndex } from '../lib/airKinds';
import { roleOf, type FillerRole, type FillerRoles } from '../lib/fillerRoles';
import type { ContentProgram, ListSummary } from '../lib/library';
import { tunarrApi } from '../lib/tunarrClient';

/** Lists whose spots are read for the log; more than this and only tagged lists are read. */
const MAX_LISTS_READ = 40;
// Stable empties for demo mode, so effects keyed on them don't re-run each render.
const NO_LISTS: ListSummary[] = [];
const NO_ROLES: FillerRoles = {};

export type FillerSpots = {
  lists: ListSummary[];
  roles: FillerRoles;
  /** Program id → role of its list, for marking rows. */
  spots: SpotIndex;
  /** List id → its spots, for break rundowns. */
  listSpots: Record<string, ListSpots>;
  /** Station ID programs by station-ID list, in list order (see `channelStationIds`). */
  stationIdsByList: Record<string, ContentProgram[]>;
  setRole: (listId: string, role: FillerRole | null) => Promise<void>;
  reload: () => void;
};

export const spotTitle = (program: ContentProgram) => {
  const meta = program.program as { title?: unknown; program?: { title?: unknown } } | undefined;
  const title = meta?.title ?? meta?.program?.title;
  return typeof title === 'string' && title ? title : 'Spot';
};

/**
 * Filler lists, the role Lineup keeps for each, and their programs: what the
 * day view needs to tell station IDs, commercials and promos apart.
 */
export function useFillerSpots(live: boolean): FillerSpots {
  const [lists, setLists] = useState<ListSummary[]>([]);
  const [roles, setRoles] = useState<FillerRoles>({});
  const [programs, setPrograms] = useState<Record<string, ContentProgram[]>>({});
  const [version, setVersion] = useState(0);

  // Folders are picked up when the desk opens: new uploads and rescans reach their lists.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    tunarrApi.syncFillerFolders()
      .then((sync) => { if (!cancelled && (sync.created.length || sync.updated.length)) setVersion((current) => current + 1); })
      .catch(() => { /* Optional: the desk works without it. */ });
    return () => { cancelled = true; };
  }, [live]);

  useEffect(() => {
    // Demo mode has no filler lists; the derived values below come out empty.
    if (!live) return;
    let cancelled = false;
    // Roles are optional: an older or read-only data dir still shows guessed roles.
    Promise.all([tunarrApi.fillerLists(), tunarrApi.fillerRoles().catch(() => ({} as FillerRoles))])
      .then(async ([found, stored]) => {
        if (cancelled) return;
        setLists(found);
        setRoles(stored);
        const read = found.length <= MAX_LISTS_READ ? found : found.filter((list) => roleOf(list, stored));
        const entries = await Promise.all(read.slice(0, MAX_LISTS_READ).map((list) => tunarrApi.fillerListPrograms(list.id).then((items) => [list.id, items] as const).catch(() => [list.id, []] as const)));
        if (!cancelled) setPrograms(Object.fromEntries(entries));
      })
      .catch(() => { /* The day view still works; rows just aren't tagged. */ });
    return () => { cancelled = true; };
  }, [live, version]);

  const derived = useMemo(() => {
    const spots: SpotIndex = new Map();
    const listSpots: Record<string, ListSpots> = {};
    const stationIdsByList: Record<string, ContentProgram[]> = {};
    for (const list of live ? lists : []) {
      const role = roleOf(list, roles);
      const items = (programs[list.id] ?? []).filter((program) => program.duration > 0);
      listSpots[list.id] = { name: list.name, role, spots: items.map((program) => ({ id: program.id, title: spotTitle(program), duration: program.duration })) };
      for (const program of items) {
        // A program in several lists takes the most specific role it has.
        if (role && (!spots.has(program.id) || role === 'station-id')) spots.set(program.id, role);
        if (role === 'station-id') (stationIdsByList[list.id] ??= []).push(program);
      }
    }
    return { spots, listSpots, stationIdsByList };
  }, [lists, live, programs, roles]);

  const setRole = useCallback(async (listId: string, role: FillerRole | null) => {
    setRoles(await tunarrApi.setFillerRole(listId, role));
  }, []);
  const reload = useCallback(() => setVersion((value) => value + 1), []);

  return { lists: live ? lists : NO_LISTS, roles: live ? roles : NO_ROLES, ...derived, setRole, reload };
}
