import { describe, expect, it } from 'vitest';
import { defaultLibrarySort, findLibraryItems, foldText, sortLibraryItems, titleNumber, type LibraryItem } from '../lib/library';

// Shaped like a downloaded series whose titles came in two languages.
const episode = (number: number, english: boolean, releaseDate?: number): LibraryItem => ({
  uuid: `e${number}`, type: 'other_video', duration: 3_000_000, releaseDate,
  title: english ? `Chapter ${number} - Widows and Children of Rock & Roll` : `Capítulo ${number} - Viudas e Hijos del Rock & Roll`,
});
const series = [episode(10, false, 10), episode(100, false, 100), episode(2, true, 3), episode(1, true, 1), episode(3, false, 2), episode(20, false, 20), episode(12, true, 12)];
const ids = (items: LibraryItem[]) => items.map((item) => item.uuid);

describe('library listings', () => {
  it('reads the episode number from either language', () => {
    expect(titleNumber({ title: 'Capítulo 2 - Viudas' })).toBe(2);
    expect(titleNumber({ title: 'Chapter 2 - Widows, Part 10' })).toBe(2);
    expect(titleNumber({ title: 'The Movie' })).toBeNull();
    expect(foldText('Capítulo ÑANDÚ')).toBe('capitulo nandu');
  });

  it('orders by episode number, naturally by title, or by release date', () => {
    expect(ids(sortLibraryItems(series, 'number'))).toEqual(['e1', 'e2', 'e3', 'e10', 'e12', 'e20', 'e100']);
    // Natural title order keeps 2 before 10 within each language.
    expect(ids(sortLibraryItems(series, 'title'))).toEqual(['e3', 'e10', 'e20', 'e100', 'e1', 'e2', 'e12']);
    expect(ids(sortLibraryItems(series, 'date'))).toEqual(['e1', 'e3', 'e2', 'e10', 'e12', 'e20', 'e100']);
    // Untitled numbers go last; the input isn't changed.
    const mixed = [{ uuid: 'm', type: 'movie', title: 'Movie' }, ...series];
    expect(sortLibraryItems(mixed, 'number').at(-1)!.uuid).toBe('m');
    expect(mixed[0].uuid).toBe('m');
  });

  it('defaults to episode order only when most programs are numbered', () => {
    expect(defaultLibrarySort(series)).toBe('number');
    expect(defaultLibrarySort([{ uuid: 'a', type: 'movie', title: 'Alien' }, { uuid: 'b', type: 'movie', title: 'Blade Runner' }, { uuid: 'c', type: 'movie', title: '2001' }])).toBe('title');
    // Shows and seasons are folders, not programs.
    expect(defaultLibrarySort([{ uuid: 's', type: 'season', title: 'Season 1' }])).toBe('title');
  });

  it('finds an episode by its number even when its title is in another language', () => {
    expect(ids(findLibraryItems(series, 'capitulo 2'))).toEqual(['e2']);
    expect(ids(findLibraryItems(series, 'Capítulo 3'))).toEqual(['e3']);
    expect(ids(findLibraryItems(series, '1'))).toEqual(['e1']);
    // Words alone match without accents, and narrow when they match.
    expect(ids(findLibraryItems(series, 'capitulo'))).toEqual(['e10', 'e100', 'e3', 'e20']);
    expect(ids(findLibraryItems(series, 'widows 12'))).toEqual(['e12']);
    expect(findLibraryItems(series, 'nothing like this')).toEqual([]);
    expect(findLibraryItems(series, '  ')).toBe(series);
    // A year counts as a number of the title.
    expect(ids(findLibraryItems([{ uuid: 'z', type: 'movie', title: 'Zulu', year: 1964 }], 'zulu 1964'))).toEqual(['z']);
  });
});
