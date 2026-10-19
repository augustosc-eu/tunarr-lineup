'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Channel } from '../../lib/lineup';
import { streamUrl } from '../../lib/tunarrClient';

type Props = {
  channel: Channel;
  /** What's on now, for the caption. */
  nowPlaying?: string;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
};

type Status = { kind: 'tuning' } | { kind: 'playing' } | { kind: 'error'; message: string };

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';

/**
 * The channel's live stream, through the companion: Tunarr's HLS with every
 * address rewritten to /api/tunarr (server/watch.ts), so the browser never
 * contacts Tunarr. Safari and TV browsers play HLS natively; elsewhere hls.js
 * is loaded on first use. CH± changes channel, Back stops.
 */
export function WatchDialog({ channel, nowPlaying, onStep, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>({ kind: 'tuning' });

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let cancelled = false;
    let destroy = () => {};
    setStatus({ kind: 'tuning' });
    const source = streamUrl(channel.id);
    const fail = (message: string) => { if (!cancelled) setStatus({ kind: 'error', message }); };
    const onPlaying = () => { if (!cancelled) setStatus({ kind: 'playing' }); };
    element.addEventListener('playing', onPlaying);
    if (element.canPlayType('application/vnd.apple.mpegurl')) {
      element.src = source;
      element.play().catch(() => { /* Autoplay may need a press of Play; the controls are there. */ });
      const onError = () => fail('The stream stopped. Tunarr may still be starting it; try again in a moment.');
      element.addEventListener('error', onError);
      destroy = () => { element.removeEventListener('error', onError); element.removeAttribute('src'); element.load(); };
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) { fail('This browser can’t play live streams.'); return; }
        // Tunarr starts the stream when asked, so the first playlist can take a few seconds.
        const hls = new Hls({ manifestLoadingTimeOut: 30_000, manifestLoadingMaxRetry: 3, levelLoadingTimeOut: 30_000, liveSyncDurationCount: 3 });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
          const code = (data.response as { code?: number } | undefined)?.code;
          fail(code === 404 ? 'Tunarr has no stream for this channel right now.' : code === 502 || code === 504 ? 'Tunarr didn’t start the stream. Check that the channel has programming.' : 'The stream stopped. Try again in a moment.');
        });
        hls.loadSource(source);
        hls.attachMedia(element);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { element.play().catch(() => {}); });
        destroy = () => hls.destroy();
      }).catch(() => fail('The player couldn’t load.'));
    }
    return () => {
      cancelled = true;
      element.removeEventListener('playing', onPlaying);
      destroy();
    };
  }, [channel.id]);

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (back(key)) { event.preventDefault(); event.stopPropagation(); onClose(); }
    else if (key === 'PageUp' || key === 'ChannelUp') { event.preventDefault(); onStep(-1); }
    else if (key === 'PageDown' || key === 'ChannelDown') { event.preventDefault(); onStep(1); }
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal watch-modal" role="dialog" aria-modal="true" aria-labelledby="watch-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="guide-head">
          <h2 id="watch-title">CH {channel.number} {channel.name}{nowPlaying ? ` · ${nowPlaying}` : ''}</h2>
          <span className="guide-controls">
            <button aria-label="Previous channel" onClick={() => onStep(-1)}>CH −</button>
            <button aria-label="Next channel" onClick={() => onStep(1)}>CH +</button>
          </span>
        </div>
        <div className="watch-frame">
          {/* Live TV has no captions track to offer here; Tunarr burns subtitles in when the channel asks for them. */}
          <video ref={video} controls autoPlay playsInline aria-label={`Live: CH ${channel.number} ${channel.name}`} />
          {status.kind === 'tuning' && <p className="watch-status" role="status">Tuning in… Tunarr starts the stream when it’s asked for.</p>}
          {status.kind === 'error' && <div className="warning watch-status" role="alert"><b>Not playing</b><span>{status.message}</span></div>}
        </div>
        <p className="hint">Watching counts as a viewer in Tunarr, like any player. CH± or PgUp/PgDn changes channel · Back stops.</p>
      </section>
    </div>
  );
}
