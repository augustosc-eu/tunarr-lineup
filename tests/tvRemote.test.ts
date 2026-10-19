import { describe, expect, it } from 'vitest';
import { addDigit, channelByNumber, MAX_RETRIES, mightContinue, nowAndNext, progress, remoteAction, retryDelay, stepChannel, visibleRows } from '../lib/tvRemote';

const channels = [{ id: 'b', number: 12 }, { id: 'a', number: 3 }, { id: 'c', number: 120 }, { id: 'd', number: 7 }];
const entry = (start: number, stop: number, title = 'Show') => ({ start, stop, type: 'content', title, detail: '' });

describe('watching like a cable box', () => {
  it('maps remote and keyboard keys to the same buttons, and arrows to channels unless the guide is open', () => {
    expect(remoteAction('5', false)).toEqual({ kind: 'digit', digit: 5 });
    expect(remoteAction('ChannelUp', false)).toEqual({ kind: 'channel', direction: 1 });
    expect(remoteAction('PageDown', false)).toEqual({ kind: 'channel', direction: -1 });
    expect(remoteAction('ArrowUp', false)).toEqual({ kind: 'channel', direction: 1 });
    expect(remoteAction('ArrowUp', true)).toEqual({ kind: 'up' });
    expect(remoteAction('PageDown', true)).toEqual({ kind: 'page', direction: 1 });
    expect(remoteAction('GoBack', true)).toEqual({ kind: 'back' });
    expect(remoteAction('Guide', false)).toEqual({ kind: 'guide' });
    expect(remoteAction('AudioVolumeMute', false)).toEqual({ kind: 'mute' });
    expect(remoteAction('q', false)).toBeNull();
  });

  it('steps up and down the dial by number, wrapping round', () => {
    expect(stepChannel(channels, 'a', 1)?.id).toBe('d');
    expect(stepChannel(channels, 'c', 1)?.id).toBe('a');
    expect(stepChannel(channels, 'a', -1)?.id).toBe('c');
    expect(stepChannel(channels, 'gone', 1)?.id).toBe('a');
    expect(stepChannel([], 'a', 1)).toBeNull();
  });

  it('tunes by number, waiting for another digit only while one could still match', () => {
    expect(addDigit('', 0)).toBe('0');
    expect(addDigit('0', 7)).toBe('7');
    expect(addDigit('1234', 5)).toBe('1234');
    expect(channelByNumber(channels, '12')?.id).toBe('b');
    expect(channelByNumber(channels, '99')).toBeNull();
    expect(mightContinue(channels, '1')).toBe(true);
    expect(mightContinue(channels, '12')).toBe(true);
    expect(mightContinue(channels, '120')).toBe(false);
    expect(mightContinue(channels, '7')).toBe(false);
  });

  it('retries a failed stream with a growing wait, then stops', () => {
    const waits = Array.from({ length: MAX_RETRIES + 1 }, (_, attempt) => retryDelay(attempt));
    expect(waits.slice(0, 3)).toEqual([2_000, 4_000, 8_000]);
    expect(Math.max(...waits.filter((wait): wait is number => wait !== null))).toBeLessThanOrEqual(15_000);
    expect(waits[MAX_RETRIES]).toBeNull();
  });

  it('finds what is on now and next, and how far it has run', () => {
    const programs = [entry(60, 90, 'Late'), entry(0, 30, 'First'), entry(30, 60, 'Second')];
    expect(nowAndNext(programs, 40)).toMatchObject({ now: { title: 'Second' }, next: { title: 'Late' } });
    expect(nowAndNext(programs, 95)).toEqual({ now: null, next: null });
    expect(nowAndNext([entry(50, 60)], 10).next?.start).toBe(50);
    expect(progress(entry(0, 100), 25)).toBe(0.25);
  });

  it('keeps the focused guide row on screen', () => {
    expect(visibleRows(3, 2, 0, 5)).toBe(0);
    expect(visibleRows(20, 7, 0, 5)).toBe(3);
    expect(visibleRows(20, 2, 3, 5)).toBe(2);
    expect(visibleRows(20, 19, 18, 5)).toBe(15);
  });
});
