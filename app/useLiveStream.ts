'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { streamUrl } from '../lib/tunarrClient';
import { MAX_RETRIES, retryDelay } from '../lib/tvRemote';

export type StreamStatus =
  | { kind: 'tuning' }
  | { kind: 'playing' }
  | { kind: 'buffering' }
  | { kind: 'retrying'; attempt: number; seconds: number; reason: string }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string };

/** Tunarr can take a while to start a stream; past this, tuning counts as failed. */
const TUNE_TIMEOUT_MS = 45_000;
/** A stream stuck buffering this long is restarted. */
const STALL_TIMEOUT_MS = 20_000;

type Handlers = { status: (status: StreamStatus) => void; autoMuted: () => void; restart: () => void };
/** Failed tries in a row, per channel; reset once a picture plays. */
type Attempts = { channelId: string; count: number };

/**
 * Starts one try at playing `channelId` in `element` and returns its cleanup.
 * Any failure (an error, no picture in time, a long stall) either schedules a
 * restart after a growing wait or, past the last try, reports the reason.
 */
function playStream(element: HTMLVideoElement, channelId: string, attempts: Attempts, on: Handlers): () => void {
  if (attempts.channelId !== channelId) { attempts.channelId = channelId; attempts.count = 0; }
  let cancelled = false;
  let done = false;
  let played = false;
  let destroy = () => {};
  const timers = new Set<number>();
  const later = (ms: number, run: () => void) => { const id = window.setTimeout(() => { timers.delete(id); run(); }, ms); timers.add(id); return id; };
  let watchdog = 0;
  const disarm = () => { window.clearTimeout(watchdog); timers.delete(watchdog); };
  const arm = (ms: number, reason: string) => { disarm(); watchdog = later(ms, () => failed(reason)); };

  // Every failure lands here once: retry after a wait, or give up with the reason.
  const failed = (reason: string) => {
    if (cancelled || done) return;
    done = true;
    disarm();
    destroy();
    const wait = retryDelay(attempts.count);
    if (wait === null) { on.status({ kind: 'error', message: reason }); return; }
    attempts.count += 1;
    const attempt = attempts.count;
    let seconds = Math.ceil(wait / 1000);
    const tick = () => {
      if (cancelled) return;
      if (seconds <= 0) { on.restart(); return; }
      on.status({ kind: 'retrying', attempt, seconds, reason });
      seconds -= 1;
      later(1000, tick);
    };
    tick();
  };

  const start = () => {
    element.play().catch((error: unknown) => {
      if (cancelled || (error as { name?: string } | null)?.name !== 'NotAllowedError') return;
      // No sound without a press first: play muted rather than show a black screen.
      element.muted = true;
      on.autoMuted();
      element.play().catch(() => { if (!cancelled) on.status({ kind: 'blocked' }); });
    });
  };
  const onPlaying = () => { if (cancelled) return; played = true; disarm(); attempts.count = 0; on.status({ kind: 'playing' }); };
  // Before the first frame the tuning timeout applies instead.
  const onWaiting = () => { if (cancelled || done || !played) return; on.status({ kind: 'buffering' }); arm(STALL_TIMEOUT_MS, 'The stream stalled.'); };
  element.addEventListener('playing', onPlaying);
  element.addEventListener('waiting', onWaiting);
  element.addEventListener('stalled', onWaiting);
  arm(TUNE_TIMEOUT_MS, 'Tunarr didn’t start the stream in time.');

  const source = streamUrl(channelId);
  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = source;
    start();
    const onError = () => failed('The stream stopped. Tunarr may still be starting it.');
    element.addEventListener('error', onError);
    destroy = () => { element.removeEventListener('error', onError); element.removeAttribute('src'); element.load(); };
  } else {
    import('hls.js').then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) { attempts.count = MAX_RETRIES; failed('This browser can’t play live streams.'); return; }
      // Tunarr starts the stream when asked, so the first playlist can take a few seconds.
      const hls = new Hls({ manifestLoadingTimeOut: 30_000, manifestLoadingMaxRetry: 3, levelLoadingTimeOut: 30_000, fragLoadingMaxRetry: 4, liveSyncDurationCount: 3 });
      let mediaRecoveries = 0;
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) { mediaRecoveries += 1; hls.recoverMediaError(); return; }
        const code = (data.response as { code?: number } | undefined)?.code;
        failed(code === 404 ? 'Tunarr has no stream for this channel right now.' : code === 502 || code === 504 ? 'Tunarr didn’t start the stream. Check that the channel has programming.' : 'The stream stopped.');
      });
      hls.on(Hls.Events.MANIFEST_PARSED, start);
      hls.loadSource(source);
      hls.attachMedia(element);
      destroy = () => hls.destroy();
    }).catch(() => { attempts.count = MAX_RETRIES; failed('The player couldn’t load.'); });
  }

  // Back online after a drop: try again straight away.
  const onOnline = () => { if (done && !cancelled) { attempts.count = 0; on.restart(); } };
  window.addEventListener('online', onOnline);
  return () => {
    cancelled = true;
    for (const id of timers) window.clearTimeout(id);
    window.removeEventListener('online', onOnline);
    element.removeEventListener('playing', onPlaying);
    element.removeEventListener('waiting', onWaiting);
    element.removeEventListener('stalled', onWaiting);
    if (!done) destroy();
  };
}

/**
 * Plays a channel's live stream through the companion (server/watch.ts) and
 * keeps it playing: failures are retried with a growing wait, a stream that
 * stalls is restarted, and coming back online retries at once. If the browser
 * won't autoplay with sound, it plays muted and says so (`autoMuted`).
 */
export function useLiveStream(video: RefObject<HTMLVideoElement | null>, channelId: string) {
  // Each try has a key; a status from an older try (or channel) reads as tuning.
  const [tries, setTries] = useState(0);
  const key = `${channelId}:${tries}`;
  const [reported, setReported] = useState<{ key: string; status: StreamStatus }>({ key: '', status: { kind: 'tuning' } });
  const [autoMuted, setAutoMuted] = useState(false);
  const attempts = useRef<Attempts>({ channelId: '', count: 0 });

  const retry = useCallback(() => { attempts.current.count = 0; setTries((value) => value + 1); }, []);

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    return playStream(element, channelId, attempts.current, {
      status: (status) => setReported({ key: key, status }),
      autoMuted: () => setAutoMuted(true),
      restart: () => setTries((value) => value + 1),
    });
  }, [channelId, key, video]);

  const status: StreamStatus = reported.key === key ? reported.status : { kind: 'tuning' };
  return { status, retry, autoMuted, clearAutoMuted: () => setAutoMuted(false) };
}
