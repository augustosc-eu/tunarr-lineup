'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  childType,
  defaultLibrarySort,
  findLibraryItems,
  sortLibraryItems,
  topLevelType,
  type LibraryItem,
  type LibrarySort,
  type MediaSource,
} from '../lib/library';
import { tunarrApi } from '../lib/tunarrClient';

const PAGE_SIZE = 100;
/**
 * Listings up to this size are loaded whole, so they can be shown in episode
 * order and searched by number here. Bigger ones page through Tunarr's search.
 */
const LOAD_ALL_MAX = 1000;
export const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

/**
 * Browsing Tunarr's libraries: a media source and library, a path of opened
 * folders (show › season), search, and the listing for where you are.
 * Shared by the library dialog and the program bin.
 */
export function useLibraryListing(wantedMediaType?: string) {
  const [sources, setSources] = useState<MediaSource[] | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [libraryId, setLibraryId] = useState('');
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [path, setPath] = useState<LibraryItem[]>([]);
  const [results, setResults] = useState<LibraryItem[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [totalHits, setTotalHits] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** The whole listing is loaded: sort and search it here instead of asking Tunarr. */
  const [complete, setComplete] = useState(false);
  const [sort, setSort] = useState<LibrarySort | null>(null);

  const source = sources?.find((item) => item.id === sourceId);
  const usableSources = useMemo(() => (sources ?? []).filter((item) => item.libraries.some((lib) => !wantedMediaType || lib.mediaType === wantedMediaType)), [sources, wantedMediaType]);
  const libraries = useMemo(() => (source?.libraries ?? []).filter((library) => !wantedMediaType || library.mediaType === wantedMediaType), [source, wantedMediaType]);
  const library = libraries.find((item) => item.id === libraryId);
  const folder = path.at(-1);

  useEffect(() => {
    let cancelled = false;
    tunarrApi.mediaSources()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        const usable = list.filter((item) => item.libraries.some((lib) => !wantedMediaType || lib.mediaType === wantedMediaType));
        const first = usable[0];
        if (first) {
          setSourceId(first.id);
          setLibraryId(first.libraries.find((lib) => !wantedMediaType || lib.mediaType === wantedMediaType)?.id ?? '');
        } else setLoading(false);
      })
      .catch((reason) => { if (!cancelled) { setError(errorText(reason)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [wantedMediaType]);

  // Load the current library or folder: whole when it's small enough, otherwise
  // a page at a time (and searched by Tunarr). A whole listing is searched here.
  const serverQuery = complete ? '' : query;
  useEffect(() => {
    if (!sourceId || complete) return;
    let cancelled = false;
    const type = folder ? childType(folder.type) : topLevelType(library?.mediaType ?? source?.mediaType);
    const search = (at: number) => tunarrApi.searchLibrary({ mediaSourceId: sourceId, libraryId: libraryId || undefined, text: folder ? undefined : serverQuery || undefined, type, parentId: folder?.uuid, page: at, limit: PAGE_SIZE });
    (async () => {
      const first = await search(page);
      let items = first.results;
      let whole = false;
      if (page === 0 && !serverQuery && first.totalHits <= LOAD_ALL_MAX) {
        for (let at = 1; at < first.totalPages && !cancelled; at += 1) items = [...items, ...(await search(at)).results];
        whole = true;
      }
      if (cancelled) return;
      setResults((current) => (page === 0 ? items : [...current, ...items]));
      setTotalPages(first.totalPages);
      setTotalHits(first.totalHits);
      if (whole) setComplete(true);
      setError('');
    })()
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [complete, folder, library?.mediaType, libraryId, page, query, serverQuery, source?.mediaType, sourceId]);

  const resetResults = () => {
    setResults([]);
    setPage(0);
    setLoading(true);
    setComplete(false);
    setSort(null);
    // A search belongs to the listing it was made in.
    setQuery('');
    setText('');
  };
  const order = sort ?? defaultLibrarySort(results);
  const shown = useMemo(() => (complete ? findLibraryItems(sortLibraryItems(results, order), query) : results), [complete, order, query, results]);

  return {
    sources, usableSources, source, sourceId, libraries, library, libraryId, path, folder,
    text, query, shown, results, totalHits, loading, error, setError, complete, order,
    canLoadMore: !complete && page + 1 < totalPages,
    setSort,
    chooseSource: (id: string) => {
      const next = sources?.find((item) => item.id === id);
      setSourceId(id);
      setLibraryId(next?.libraries.find((lib) => !wantedMediaType || lib.mediaType === wantedMediaType)?.id ?? '');
      setPath([]);
      resetResults();
    },
    chooseLibrary: (id: string) => {
      setLibraryId(id);
      setPath([]);
      resetResults();
    },
    open: (item: LibraryItem) => {
      setPath((current) => [...current, item]);
      resetResults();
    },
    goUp: (depth: number) => {
      setPath((current) => current.slice(0, depth));
      resetResults();
    },
    /** Typing: a whole listing is filtered as you type; a paged one waits for Search. */
    type: (value: string) => {
      setText(value);
      if (complete) setQuery(value.trim());
    },
    search: () => {
      const next = text.trim();
      if (complete) { setQuery(next); return; }
      setPath([]);
      resetResults();
      setText(next);
      setQuery(next);
    },
    loadMore: () => { setLoading(true); setPage((value) => value + 1); },
  };
}
