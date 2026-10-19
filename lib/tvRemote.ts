// Watching live like a cable box: the remote's buttons, tuning by number,
// the last-channel button, retrying a stream that drops, and the paging of
// the classic on-screen guide. Pure helpers, so they test without a player.
import type { GuideEntry } from '../server/watch';

export type RemoteAction =
  | { kind: 'digit'; digit: number }
  | { kind: 'channel'; direction: 1 | -1 }
  | { kind: 'up' } | { kind: 'down' } | { kind: 'left' } | { kind: 'right' }
  | { kind: 'ok' } | { kind: 'back' } | { kind: 'guide' } | { kind: 'info' } | { kind: 'last' }
  | { kind: 'mute' } | { kind: 'volume'; direction: 1 | -1 } | { kind: 'play' } | { kind: 'fullscreen' }
  | { kind: 'page'; direction: 1 | -1 };

/**
 * A key press as a remote button. TV browsers send ChannelUp, Info, Guide and
 * the media keys; a keyboard stands in with PgUp/PgDn, I, G, M, F and the digits.
 * PgUp and CH+ go up the dial (to a higher number), as on a cable box.
 */
export function remoteAction(key: string, guideOpen: boolean): RemoteAction | null {
  if (/^[0-9]$/.test(key)) return { kind: 'digit', digit: Number(key) };
  switch (key) {
    case 'Escape': case 'GoBack': case 'BrowserBack': case 'Exit': return { kind: 'back' };
    case 'Enter': case 'Select': return { kind: 'ok' };
    case 'ArrowUp': return guideOpen ? { kind: 'up' } : { kind: 'channel', direction: 1 };
    case 'ArrowDown': return guideOpen ? { kind: 'down' } : { kind: 'channel', direction: -1 };
    case 'ArrowLeft': return { kind: 'left' };
    case 'ArrowRight': return { kind: 'right' };
    case 'PageUp': case 'ChannelUp': return guideOpen ? { kind: 'page', direction: -1 } : { kind: 'channel', direction: 1 };
    case 'PageDown': case 'ChannelDown': return guideOpen ? { kind: 'page', direction: 1 } : { kind: 'channel', direction: -1 };
    case 'g': case 'G': case 'Guide': case 'ColorF2Yellow': return { kind: 'guide' };
    case 'i': case 'I': case 'Info': case 'ColorF3Blue': return { kind: 'info' };
    case 'r': case 'R': case 'LastChannel': case 'MediaLast': return { kind: 'last' };
    case 'm': case 'M': case 'AudioVolumeMute': case 'VolumeMute': return { kind: 'mute' };
    case '+': case '=': case 'AudioVolumeUp': case 'VolumeUp': return { kind: 'volume', direction: 1 };
    case '-': case '_': case 'AudioVolumeDown': case 'VolumeDown': return { kind: 'volume', direction: -1 };
    case ' ': case 'k': case 'K': case 'MediaPlayPause': case 'MediaPlay': case 'MediaPause': return { kind: 'play' };
    case 'f': case 'F': return { kind: 'fullscreen' };
    default: return null;
  }
}

type Numbered = { id: string; number: number };

/** The next channel up (1) or down (-1) the dial, wrapping round, as CH± does. */
export function stepChannel<T extends Numbered>(channels: T[], currentId: string, direction: 1 | -1): T | null {
  if (!channels.length) return null;
  const dial = [...channels].sort((a, b) => a.number - b.number);
  const index = dial.findIndex((channel) => channel.id === currentId);
  if (index < 0) return dial[direction > 0 ? 0 : dial.length - 1];
  return dial[(index + direction + dial.length) % dial.length];
}

/** Digits typed on the remote stop at four, like a cable box's CH entry. */
export const MAX_DIGITS = 4;
/** How long the box waits for the next digit before tuning. */
export const DIGIT_WAIT_MS = 1_800;

export const addDigit = (entry: string, digit: number) => (entry.length >= MAX_DIGITS ? entry : `${entry}${digit}`.replace(/^0+(?=\d)/, ''));

/** The channel with exactly that number, or null. */
export function channelByNumber<T extends Numbered>(channels: T[], entry: string): T | null {
  if (!/^\d+$/.test(entry)) return null;
  const number = Number(entry);
  return channels.find((channel) => channel.number === number) ?? null;
}

/** Whether another digit could still name a channel (so the box should wait for it). */
export const mightContinue = (channels: Numbered[], entry: string) =>
  entry.length < MAX_DIGITS && channels.some((channel) => String(channel.number).startsWith(entry) && String(channel.number) !== entry);

/**
 * How long to wait before retrying a stream that failed: Tunarr starts a
 * stream when it's asked for, so the first tries often fail. Null means stop.
 */
export const MAX_RETRIES = 5;
export const retryDelay = (attempt: number): number | null => (attempt >= MAX_RETRIES ? null : Math.min(15_000, 2_000 * 2 ** attempt));

/** What's on now and next on a channel. */
export function nowAndNext(programs: GuideEntry[], time: number): { now: GuideEntry | null; next: GuideEntry | null } {
  const sorted = [...programs].sort((a, b) => a.start - b.start);
  const index = sorted.findIndex((entry) => entry.start <= time && time < entry.stop);
  if (index >= 0) return { now: sorted[index], next: sorted[index + 1] ?? null };
  return { now: null, next: sorted.find((entry) => entry.start > time) ?? null };
}

/** How far the program has run, 0–1. */
export const progress = (entry: GuideEntry, time: number) => Math.max(0, Math.min(1, (time - entry.start) / (entry.stop - entry.start)));

/** The classic guide shows ninety minutes: three half-hour columns. */
export const CLASSIC_SPAN_MS = 90 * 60_000;
/** It loads three hours at once, so two pages share one request. */
export const CLASSIC_LOAD_MS = 2 * CLASSIC_SPAN_MS;
/** And, like the boxes of the time, it only looks ahead (about half a day). */
export const CLASSIC_MAX_PAGE = 8;

/** Which rows are on screen: the focused row stays inside a page of `size`. */
export function visibleRows(total: number, focus: number, top: number, size: number): number {
  if (total <= size) return 0;
  if (focus < top) return focus;
  if (focus >= top + size) return focus - size + 1;
  return Math.min(top, total - size);
}
