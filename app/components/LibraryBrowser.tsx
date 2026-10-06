'use client';

import { useEffect, useMemo, useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import {
  childType,
  defaultLibrarySort,
  findLibraryItems,
  isPlayable,
  itemLabel,
  LIBRARY_SORT_LABELS,
  sortLibraryItems,
  titleNumber,
  toContentProgram,
  topLevelType,
  TYPE_LABELS,
  type ContentProgram,
  type LibraryItem,
  type LibrarySort,
  type MediaSource,
} from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';

export type LibraryPick = { programs: ContentProgram[] } | { show: { id: string; title: string; mediaSourceId?: string; libraryId?: string } };

type Props = {
  title: string;
  /** programs: pick any playable items; show: pick one TV show; movies: pick movies. */
  mode: 'programs' | 'show' | 'movies';
  confirmLabel?: string;
  onPick: (pick: LibraryPick) => void;
  onClose: () => void;
};

const PAGE_SIZE = 100;
/**
 * Listings up to this size are loaded whole, so they can be shown in episode
 * order and searched by number here. Bigger ones page through Tunarr's search.
 */
const LOAD_ALL_MAX = 1000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

export function LibraryBrowser({ title, mode, confirmLabel = 'Add', onPick, onClose }: Props) {
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
  const [basket, setBasket] = useState<ContentProgram[]>([]);
  const [adding, setAdding] = useState('');
  /** The whole listing is loaded: sort and search it here instead of asking Tunarr. */
  const [complete, setComplete] = useState(false);
  const [sort, setSort] = useState<LibrarySort | null>(null);

  const wantedMediaType = mode === 'show' ? 'shows' : mode === 'movies' ? 'movies' : undefined;
  const source = sources?.find((item) => item.id === sourceId);
  const libraries = useMemo(() => (source?.libraries ?? []).filter((library) => !wantedMediaType || library.mediaType === wantedMediaType), [source, wantedMediaType]);
  const library = libraries.find((item) => item.id === libraryId);
  const folder = path.at(-1);
  const basketIds = useMemo(() => new Set(basket.map((program) => program.id)), [basket]);
  const basketDuration = basket.reduce((sum, program) => sum + program.duration, 0);

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
        }
      })
      .catch((reason) => { if (!cancelled) setError(errorText(reason)); });
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
  const chooseSource = (id: string) => {
    const next = sources?.find((item) => item.id === id);
    setSourceId(id);
    setLibraryId(next?.libraries.find((lib) => !wantedMediaType || lib.mediaType === wantedMediaType)?.id ?? '');
    setPath([]);
    resetResults();
  };
  const open = (item: LibraryItem) => {
    setPath((current) => [...current, item]);
    resetResults();
  };
  const goUp = (depth: number) => {
    setPath((current) => current.slice(0, depth));
    resetResults();
  };

  const addPrograms = (programs: ContentProgram[]) => {
    const playable = programs.filter((program) => program.duration > 0 && !basketIds.has(program.id));
    setBasket((current) => [...current, ...playable]);
  };
  const addAll = async (item: LibraryItem) => {
    setAdding(item.uuid);
    try {
      const programs = await tunarrApi.descendants(item.uuid);
      addPrograms(mode === 'movies' ? programs.filter((program) => (program.program as LibraryItem).type === 'movie') : programs);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setAdding('');
    }
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal library-modal" role="dialog" aria-modal="true" aria-labelledby="library-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">LIBRARY</p>
        <h2 id="library-title">{title}</h2>
        <div className="library-pickers">
          <label className="field"><span>Media source</span>
            <select value={sourceId} onChange={(event) => chooseSource(event.target.value)} disabled={!sources}>
              {(sources ?? []).filter((item) => item.libraries.some((lib) => !wantedMediaType || lib.mediaType === wantedMediaType)).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Library</span>
            <select value={libraryId} onChange={(event) => { setLibraryId(event.target.value); setPath([]); resetResults(); }} disabled={!libraries.length}>
              {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <form className="library-search" onSubmit={(event) => {
            event.preventDefault();
            const next = text.trim();
            if (complete) { setQuery(next); return; }
            setPath([]);
            resetResults();
            setText(next);
            setQuery(next);
          }}>
            <label className="search"><span>⌕</span><input aria-label="Search the library" placeholder={complete ? 'Find by title or number' : 'Search this library'} value={text} onChange={(event) => { setText(event.target.value); if (complete) setQuery(event.target.value.trim()); }} /></label>
            <button type="submit">Search</button>
          </form>
          {complete && <label className="field"><span>Order</span>
            <select aria-label="Order" value={order} onChange={(event) => setSort(event.target.value as LibrarySort)}>
              {(Object.keys(LIBRARY_SORT_LABELS) as LibrarySort[]).map((value) => <option key={value} value={value}>{LIBRARY_SORT_LABELS[value]}</option>)}
            </select>
          </label>}
        </div>

        <nav className="library-path" aria-label="Location">
          <button className="quiet" onClick={() => goUp(0)} disabled={!path.length}>{library?.name ?? source?.name ?? 'Library'}{query && !path.length ? ` · “${query}”` : ''}</button>
          {path.map((item, index) => <span key={item.uuid}> › <button className="quiet" onClick={() => goUp(index + 1)} disabled={index === path.length - 1}>{itemLabel(item)}</button></span>)}
          <small>{complete && query ? `${shown.length.toLocaleString('en')} of ${results.length.toLocaleString('en')}` : `${totalHits.toLocaleString('en')} ${totalHits === 1 ? 'item' : 'items'}`}</small>
        </nav>

        <div className="library-list" aria-busy={loading}>
          {error && <div className="warning" role="alert"><b>Library unavailable</b><span>{error}</span></div>}
          {!loading && !error && !shown.length && <p className="subtle candidate-empty">{query ? `Nothing matches “${query}”.` : 'Nothing here.'}</p>}
          {shown.map((item) => {
            const folderType = childType(item.type);
            const playable = isPlayable(item);
            const picked = basketIds.has(item.uuid);
            return (
              <div className="candidate library-item" key={item.uuid}>
                <span className="mini-art blue">{complete && order === 'number' && titleNumber(item) !== null ? titleNumber(item) : (item.title || '?').slice(0, 1)}</span>
                <span><b>{itemLabel(item)}</b><small>{TYPE_LABELS[item.type] ?? item.type}{item.duration ? ` · ${durationTimecode(item.duration)}` : ''}{item.childCount ? ` · ${item.childCount} ${folderType ?? 'item'}s` : ''}</small></span>
                <span className="candidate-actions">
                  {mode === 'show' && item.type === 'show' && <button className="primary" aria-label={`Use ${itemLabel(item)}`} onClick={() => onPick({ show: { id: item.uuid, title: item.title, mediaSourceId: sourceId, libraryId: libraryId || undefined } })}>Use this show</button>}
                  {folderType && mode !== 'show' && <button aria-label={`Open ${itemLabel(item)}`} onClick={() => open(item)}>Open</button>}
                  {folderType && mode !== 'show' && <button aria-label={`Add all of ${itemLabel(item)}`} disabled={adding === item.uuid} onClick={() => void addAll(item)}>{adding === item.uuid ? 'Adding…' : 'Add all'}</button>}
                  {playable && mode !== 'show' && <button aria-label={`${picked ? 'Added' : 'Add'} ${itemLabel(item)}`} disabled={picked} onClick={() => addPrograms([toContentProgram(item)])}>{picked ? 'Added' : 'Add'}</button>}
                </span>
              </div>
            );
          })}
          {!complete && page + 1 < totalPages && <button className="wide" disabled={loading} onClick={() => { setLoading(true); setPage((value) => value + 1); }}>{loading ? 'Loading…' : 'Load more'}</button>}
        </div>

        {mode !== 'show' && basket.length > 0 && <ol className="basket-list" aria-label="Selected programs">
          {basket.map((program) => {
            const label = itemLabel(program.program as LibraryItem);
            return <li key={program.id}><span>{label}</span><small>{durationTimecode(program.duration)}</small><button className="quiet" aria-label={`Remove ${label}`} onClick={() => setBasket((current) => current.filter((entry) => entry.id !== program.id))}>×</button></li>;
          })}
        </ol>}
        {mode !== 'show' && <div className="dialog-actions library-basket">
          <span>{basket.length ? <><b>{basket.length.toLocaleString('en')}</b> selected · {durationTimecode(basketDuration)}</> : 'Nothing selected yet.'}</span>
          <span className="spacer" />
          <button disabled={!basket.length} onClick={() => setBasket([])}>Clear</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!basket.length} onClick={() => onPick({ programs: basket })}>{confirmLabel} {basket.length ? basket.length.toLocaleString('en') : ''}</button>
        </div>}
        {mode === 'show' && <div className="dialog-actions"><button onClick={onClose}>Cancel</button></div>}
      </section>
    </div>
  );
}
