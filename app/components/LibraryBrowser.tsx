'use client';

import { useMemo, useState } from 'react';
import { durationTimecode } from '../../lib/broadcast';
import {
  childType,
  isPlayable,
  itemLabel,
  LIBRARY_SORT_LABELS,
  titleNumber,
  toContentProgram,
  TYPE_LABELS,
  type ContentProgram,
  type LibraryItem,
  type LibrarySort,
} from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';
import { errorText, useLibraryListing } from '../useLibraryListing';

export type LibraryPick = { programs: ContentProgram[] } | { show: { id: string; title: string; mediaSourceId?: string; libraryId?: string } };

type Props = {
  title: string;
  /** programs: pick any playable items; show: pick one TV show; movies: pick movies. */
  mode: 'programs' | 'show' | 'movies';
  confirmLabel?: string;
  onPick: (pick: LibraryPick) => void;
  onClose: () => void;
};

export function LibraryBrowser({ title, mode, confirmLabel = 'Add', onPick, onClose }: Props) {
  const wantedMediaType = mode === 'show' ? 'shows' : mode === 'movies' ? 'movies' : undefined;
  const listing = useLibraryListing(wantedMediaType);
  const { sources, usableSources, source, sourceId, libraries, library, libraryId, path, text, query, shown, results, totalHits, loading, error, setError, complete, order } = listing;
  const [basket, setBasket] = useState<ContentProgram[]>([]);
  const [adding, setAdding] = useState('');
  const basketIds = useMemo(() => new Set(basket.map((program) => program.id)), [basket]);
  const basketDuration = basket.reduce((sum, program) => sum + program.duration, 0);
  const { open, goUp } = listing;

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
            <select value={sourceId} onChange={(event) => listing.chooseSource(event.target.value)} disabled={!sources}>
              {usableSources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="field"><span>Library</span>
            <select value={libraryId} onChange={(event) => listing.chooseLibrary(event.target.value)} disabled={!libraries.length}>
              {libraries.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <form className="library-search" onSubmit={(event) => {
            event.preventDefault();
            listing.search();
          }}>
            <label className="search"><span>⌕</span><input aria-label="Search the library" placeholder={complete ? 'Find by title or number' : 'Search this library'} value={text} onChange={(event) => listing.type(event.target.value)} /></label>
            <button type="submit">Search</button>
          </form>
          {complete && <label className="field"><span>Order</span>
            <select aria-label="Order" value={order} onChange={(event) => listing.setSort(event.target.value as LibrarySort)}>
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
          {listing.canLoadMore && <button className="wide" disabled={loading} onClick={listing.loadMore}>{loading ? 'Loading…' : 'Load more'}</button>}
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
