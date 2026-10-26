// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { epgEntries, epgIssues, toXmltv, xmltvTime } from '../lib/epg';
import type { GuideChannel } from '../server/watch';

const MIN = 60_000;
const FROM = Date.UTC(2026, 9, 31, 18);
const channel = (programs: GuideChannel['programs']): GuideChannel => ({ id: '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa', number: 5, name: 'Desk News', programs });
const entry = (start: number, minutes: number, title: string, extra: Partial<GuideChannel['programs'][number]> = {}) => ({ start, stop: start + minutes * MIN, type: 'content', title, detail: '', ...extra });

describe('the guide preview', () => {
  it('lists entries in time order with categories', () => {
    const entries = epgEntries(channel([entry(FROM + 30 * MIN, 30, 'B'), entry(FROM, 30, 'A', { detail: 'S01 E02 · Pilot' }), entry(FROM + 60 * MIN, 10, 'Desk News', { type: 'flex' })]));
    expect(entries.map((item) => [item.title, item.subtitle, item.category, item.flex])).toEqual([['A', 'S01 E02 · Pilot', 'Program', false], ['B', '', 'Program', false], ['Desk News', '', 'Filler', true]]);
  });

  it('finds holes, overlaps, unreadable entries, generic flex titles and empty guides', () => {
    const issues = epgIssues(channel([
      entry(FROM + 5 * MIN, 30, 'Late start'),
      entry(FROM + 40 * MIN, 30, 'After a hole'),
      entry(FROM + 65 * MIN, 0.25, 'Bumper'),
      entry(FROM + 66 * MIN, 20, 'Desk News', { type: 'flex' }),
    ]), FROM, FROM + 120 * MIN);
    expect(issues.map((issue) => issue.title)).toEqual([
      '5 minutes missing at the start',
      'A 5-minute hole',
      'Two entries overlap',
      // The bumper ends at 65:15 and the flex starts at 66:00.
      'A 1-minute hole',
      'A 15-second entry',
      'Flex time listed with a generic title',
      '34 minutes missing at the end',
    ]);
    expect(epgIssues(channel([]), FROM, FROM + MIN)[0].title).toBe('Nothing in the guide');
    // A guide title for flex, and a minimum entry length, quiet those notes.
    const quiet = epgIssues(channel([entry(FROM, 60, 'Desk News', { type: 'flex' })]), FROM, FROM + 60 * MIN, { flexTitle: 'Stay tuned' });
    expect(quiet).toEqual([]);
  });

  it('writes a well-formed XMLTV preview, escaping what needs it', () => {
    const xml = toXmltv([channel([entry(FROM, 30, 'Tom & Jerry <Classic>', { detail: '"Quotes" & \'apostrophes\'\u0001' })])], FROM, FROM + 60 * MIN);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    const programme = doc.getElementsByTagName('programme')[0];
    expect(programme.getAttribute('start')).toBe('20261031180000 +0000');
    expect(programme.getAttribute('channel')).toBe('5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa');
    expect(programme.getElementsByTagName('title')[0].textContent).toBe('Tom & Jerry <Classic>');
    expect(programme.getElementsByTagName('sub-title')[0].textContent).toBe('"Quotes" & \'apostrophes\'');
    expect(doc.getElementsByTagName('display-name')[1].textContent).toBe('5');
    expect(xml).toContain('Tunarr serves the real guide');
    expect(xmltvTime(Date.UTC(2026, 0, 2, 3, 4, 5))).toBe('20260102030405 +0000');
  });
});
