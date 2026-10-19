'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { stepFocus, windowStart, type GuideChannel } from '../../lib/guideGrid';
import type { Channel } from '../../lib/lineup';
import type { ViewerCounts } from '../../lib/tunarrClient';
import { addDigit, channelByNumber, CLASSIC_LOAD_MS, CLASSIC_MAX_PAGE, CLASSIC_SPAN_MS, DIGIT_WAIT_MS, MAX_RETRIES, mightContinue, nowAndNext, progress, remoteAction, stepChannel, visibleRows, type RemoteAction } from '../../lib/tvRemote';
import { useLiveStream } from '../useLiveStream';
import { CableGuide, clock, type CableFocus } from './CableGuide';
import { TvRemote } from './TvRemote';

type Props = {
  channel: Channel;
  channels: Channel[];
  now: number;
  viewers: ViewerCounts;
  /** Loads the guide for every channel in [from, to). */
  loadGuide: (from: number, to: number) => Promise<GuideChannel[]>;
  logo: (channel: Channel) => ReactNode;
  onTune: (channelId: string) => void;
  onClose: () => void;
};

/** How long the channel banner stays up after tuning. */
const BANNER_MS = 5_000;
const OSD_MS = 1_800;
const GUIDE_ROWS = 5;

/**
 * The channel's live stream, through the companion: Tunarr's HLS with every
 * address rewritten to /api/tunarr (server/watch.ts), so the browser never
 * contacts Tunarr. Works like a cable box: CH± and the digits tune, LAST goes
 * back, INFO shows the banner, GUIDE opens the classic on-screen guide with the
 * picture still playing. The remote beside the picture does the same by mouse.
 */
export function WatchDialog({ channel, channels, now, viewers, loadGuide, logo, onTune, onClose }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const section = useRef<HTMLElement>(null);
  const { status, retry, autoMuted, clearAutoMuted } = useLiveStream(video, channel.id);
  const dial = useMemo(() => [...channels].sort((a, b) => a.number - b.number), [channels]);

  // The guide, in three-hour chunks from the current half hour (kept, so paging back is instant).
  const base = windowStart(now);
  const [chunks, setChunks] = useState<Record<number, GuideChannel[]>>({});
  const [chunkErrors, setChunkErrors] = useState<Record<number, string>>({});
  const chunkFor = (page: number) => base + Math.floor(page / 2) * CLASSIC_LOAD_MS;
  const request = useCallback((from: number) => {
    setChunkErrors((current) => { if (!(from in current)) return current; const next = { ...current }; delete next[from]; return next; });
    loadGuide(from, from + CLASSIC_LOAD_MS)
      .then((data) => setChunks((current) => ({ ...current, [from]: data })))
      .catch((reason) => setChunkErrors((current) => ({ ...current, [from]: reason instanceof Error ? reason.message : 'Couldn’t load the guide.' })));
  }, [loadGuide]);
  const requested = useRef(new Set<number>());
  const want = useCallback((from: number) => { if (requested.current.has(from)) return; requested.current.add(from); request(from); }, [request]);
  useEffect(() => { want(base); }, [base, want]);

  // What's on the tuned channel now, for the title and the banner.
  const tunedPrograms = chunks[base]?.find((item) => item.id === channel.id)?.programs ?? [];
  const onNow = nowAndNext(tunedPrograms, now);

  const [guideOpen, setGuideOpen] = useState(false);
  const [focus, setFocus] = useState<CableFocus>({ row: 0, time: now, page: 0, top: 0 });
  // The banner shows for a while on every tune (per channel), or stays when pinned with INFO.
  const [bannerState, setBannerState] = useState<{ channelId: string; mode: 'auto' | 'pinned' | null }>({ channelId: channel.id, mode: 'auto' });
  const banner = bannerState.channelId === channel.id || bannerState.mode === 'pinned' ? bannerState.mode : 'auto';
  const setBanner = (mode: 'auto' | 'pinned' | null) => setBannerState({ channelId: channel.id, mode });
  const [digits, setDigits] = useState('');
  const [osd, setOsd] = useState<{ text: string; key: number } | null>(null);
  const [mutedByUser, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  // The channel before this one, for LAST (updated while rendering, when the channel changes).
  const [tuned, setTuned] = useState<{ current: string; last: string | null }>({ current: channel.id, last: null });
  if (tuned.current !== channel.id) setTuned({ current: channel.id, last: tuned.current });
  const lastChannel = tuned.last && channels.some((item) => item.id === tuned.last) ? tuned.last : null;

  useEffect(() => {
    if (banner !== 'auto') return;
    const timer = window.setTimeout(() => setBannerState({ channelId: channel.id, mode: null }), BANNER_MS);
    return () => window.clearTimeout(timer);
  }, [banner, channel.id]);
  useEffect(() => {
    if (!osd) return;
    const timer = window.setTimeout(() => setOsd(null), OSD_MS);
    return () => window.clearTimeout(timer);
  }, [osd]);
  const flash = (text: string) => setOsd({ text, key: Date.now() });

  // The player's sound follows the remote; autoplay without sound shows as muted.
  const muted = mutedByUser || autoMuted;
  useEffect(() => { const element = video.current; if (element) { element.muted = muted; element.volume = volume; } }, [muted, volume]);
  useEffect(() => { section.current?.focus({ preventScroll: true }); }, []);

  const tune = (channelId: string | null | undefined) => {
    if (!channelId) return;
    if (channelId === channel.id) { setBanner('auto'); return; }
    onTune(channelId);
  };

  // Typed digits tune after a pause, or at once when no longer number could match.
  const commitDigits = (entry: string) => {
    setDigits('');
    const match = channelByNumber(dial, entry);
    if (!match) { flash(`CH ${entry} isn’t on this lineup`); return; }
    if (guideOpen) {
      const row = dial.indexOf(match);
      setFocus((current) => ({ ...current, row, top: visibleRows(dial.length, row, current.top, GUIDE_ROWS) }));
    } else tune(match.id);
  };
  const typeDigit = (digit: number) => {
    const entry = addDigit(digits, digit);
    if (mightContinue(dial, entry)) setDigits(entry);
    else commitDigits(entry);
  };
  const commitLatest = useRef(commitDigits);
  useEffect(() => { commitLatest.current = commitDigits; });
  useEffect(() => {
    if (!digits) return;
    const timer = window.setTimeout(() => commitLatest.current(digits), DIGIT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [digits]);

  const openGuide = () => {
    const row = Math.max(0, dial.findIndex((item) => item.id === channel.id));
    setFocus({ row, time: now, page: 0, top: visibleRows(dial.length, row, Math.max(0, row - 2), GUIDE_ROWS) });
    setGuideOpen(true);
    setBanner(null);
  };
  const closeGuide = () => { setGuideOpen(false); section.current?.focus({ preventScroll: true }); };

  const guideFrom = base + focus.page * CLASSIC_SPAN_MS;
  const guideChunk = chunkFor(focus.page);
  useEffect(() => { if (guideOpen) want(guideChunk); }, [guideChunk, guideOpen, want]);
  const pageOf = (time: number) => Math.max(0, Math.min(CLASSIC_MAX_PAGE, Math.floor((time - base) / CLASSIC_SPAN_MS)));

  const moveGuide = (action: RemoteAction) => {
    const rowChannel = dial[focus.row];
    const programs = (rowChannel && chunks[guideChunk]?.find((item) => item.id === rowChannel.id)?.programs) || [];
    const to = guideFrom + CLASSIC_SPAN_MS;
    const at = Math.max(guideFrom, Math.min(focus.time, to - 1));
    const setRow = (row: number) => setFocus((current) => {
      const next = Math.max(0, Math.min(dial.length - 1, row));
      return { ...current, row: next, top: visibleRows(dial.length, next, current.top, GUIDE_ROWS) };
    });
    switch (action.kind) {
      case 'up': setRow(focus.row - 1); break;
      case 'down': setRow(focus.row + 1); break;
      case 'page': setRow(focus.row + action.direction * GUIDE_ROWS); break;
      case 'channel': setRow(focus.row - action.direction * GUIDE_ROWS); break;
      case 'left': case 'right': {
        const direction = action.kind === 'right' ? 1 : -1;
        const step = stepFocus(programs, at, direction);
        // Past the data on this page: turn the page, as the box did.
        const time = Math.max(base, step ?? (direction > 0 ? to : guideFrom - 1));
        const page = pageOf(time);
        if (direction > 0 && time >= base + (CLASSIC_MAX_PAGE + 1) * CLASSIC_SPAN_MS) break;
        setFocus((current) => ({ ...current, page, time: Math.max(time, base + page * CLASSIC_SPAN_MS) }));
        break;
      }
      case 'ok': {
        if (rowChannel) { closeGuide(); tune(rowChannel.id); }
        break;
      }
      default: break;
    }
  };

  const toggleFullscreen = () => {
    const element = screen.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    else void element.requestFullscreen?.().catch(() => flash('Full screen isn’t available here'));
  };

  const act = (action: RemoteAction) => {
    switch (action.kind) {
      case 'digit': typeDigit(action.digit); return;
      case 'back':
        if (digits) setDigits('');
        else if (guideOpen) closeGuide();
        else if (banner) setBanner(null);
        else onClose();
        return;
      case 'guide': if (guideOpen) closeGuide(); else openGuide(); return;
      case 'info': if (guideOpen) closeGuide(); setBanner(banner ? null : 'pinned'); return;
      case 'last': if (lastChannel) tune(lastChannel); else flash('No last channel yet'); return;
      case 'mute': flash(muted ? 'Sound on' : 'Mute'); setMuted(!muted); clearAutoMuted(); return;
      case 'volume': {
        const next = Math.round(Math.max(0, Math.min(1, volume + action.direction * 0.1)) * 10) / 10;
        setVolume(next);
        setMuted(false);
        clearAutoMuted();
        flash(`Volume ${'▮'.repeat(next * 10)}${'▯'.repeat(10 - next * 10)}`);
        return;
      }
      case 'play': {
        const element = video.current;
        if (!element) return;
        if (element.paused) { void element.play().catch(() => {}); flash('▶ Play'); } else { element.pause(); flash('❚❚ Pause'); }
        return;
      }
      case 'fullscreen': toggleFullscreen(); return;
      default: break;
    }
    if (digits && action.kind === 'ok') { commitDigits(digits); return; }
    if (guideOpen) { moveGuide(action); return; }
    if (action.kind === 'channel') tune(stepChannel(dial, channel.id, action.direction)?.id);
    else if (action.kind === 'up' || action.kind === 'down') tune(stepChannel(dial, channel.id, action.kind === 'up' ? 1 : -1)?.id);
    else if (action.kind === 'ok') {
      if (status.kind === 'blocked' || video.current?.paused) void video.current?.play().catch(() => {});
      else if (status.kind === 'error') retry();
      else setBanner(banner ? null : 'auto');
    }
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // A focused button (on the remote, or a guide cell) answers OK and Space itself.
    if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).closest('button')) return;
    if (event.key === 'Backspace' && digits) { event.preventDefault(); setDigits((current) => current.slice(0, -1)); return; }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const action = remoteAction(event.key, guideOpen);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    act(action);
  };

  const watchingCount = viewers[channel.id]?.viewers ?? 0;
  const statusLine = status.kind === 'tuning' ? 'Tuning…'
    : status.kind === 'buffering' ? 'Buffering…'
      : status.kind === 'retrying' ? `No signal · retrying in ${status.seconds} s (${status.attempt} of ${MAX_RETRIES})`
        : status.kind === 'error' ? 'Not playing'
          : status.kind === 'blocked' ? 'Press OK to play' : 'Live';

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={section} tabIndex={-1} className="modal watch-modal" role="dialog" aria-modal="true" aria-labelledby="watch-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <div className="guide-head">
          <h2 id="watch-title">CH {channel.number} {channel.name}{onNow.now ? ` · ${onNow.now.title}` : ''}</h2>
          <span className={`watch-signal ${status.kind}`} role="status">{statusLine}</span>
        </div>
        <div className="watch-body">
          <div ref={screen} className={`tv-screen ${guideOpen ? 'guide-on' : ''}`}>
            {/* Live TV has no captions track to offer here; Tunarr burns subtitles in when the channel asks for them. */}
            <video ref={video} autoPlay playsInline aria-label={`Live: CH ${channel.number} ${channel.name}`} onDoubleClick={toggleFullscreen} />
            {(status.kind === 'tuning' || status.kind === 'retrying') && !guideOpen && <div className="tv-static" aria-hidden="true" />}
            {status.kind === 'tuning' && !guideOpen && <p className="tv-message">Tuning CH {channel.number}… Tunarr starts the stream when it’s asked for.</p>}
            {status.kind === 'retrying' && !guideOpen && <div className="tv-message" role="alert"><b>No signal</b> {status.reason} Trying again in {status.seconds} s. <button type="button" onClick={retry}>Retry now</button></div>}
            {status.kind === 'error' && !guideOpen && <div className="tv-message warning" role="alert"><b>Not playing</b><span>{status.message}</span><span><button type="button" onClick={retry}>Try again</button> <button type="button" onClick={onClose}>Back to the desk</button></span></div>}
            {status.kind === 'blocked' && !guideOpen && <button type="button" className="tv-play" onClick={() => void video.current?.play().catch(() => {})}>▶ Press OK to play</button>}
            {autoMuted && muted && !guideOpen && <p className="tv-chip">🔇 Sound is off · press Mute for sound</p>}
            {digits && <p className="tv-digits" aria-live="assertive">CH {digits}{'–'.repeat(Math.max(0, String(dial[dial.length - 1]?.number ?? 0).length - digits.length))}</p>}
            {osd && <p key={osd.key} className="tv-osd" role="status">{osd.text}</p>}
            {banner && !guideOpen && (
              <div className="tv-banner" role="status">
                <span className="tv-banner-logo">{logo(channel)}</span>
                <span className="tv-banner-channel"><b>{channel.number}</b> {channel.name}<small>{[channel.groupTitle, watchingCount > 0 ? `● ${watchingCount} watching` : ''].filter(Boolean).join(' · ') || 'Live'}</small></span>
                <span className="tv-banner-now">
                  {onNow.now ? <>
                    <b>{onNow.now.title}</b>
                    <small>{clock(onNow.now.start)} – {clock(onNow.now.stop)}{onNow.now.detail ? ` · ${onNow.now.detail}` : ''}</small>
                    <span className="cable-progress" aria-hidden="true"><i style={{ width: `${progress(onNow.now, now) * 100}%` }} /></span>
                  </> : <b>{chunks[base] ? 'No listing' : chunkErrors[base] ? 'Guide unavailable' : 'Loading listing…'}</b>}
                  {onNow.next && <small>Next {clock(onNow.next.start)} · {onNow.next.title}</small>}
                </span>
                <span className="tv-banner-clock">{clock(now)}</span>
              </div>
            )}
            {guideOpen && <CableGuide
              dial={dial}
              currentId={channel.id}
              now={now}
              base={base}
              focus={focus}
              rows={GUIDE_ROWS}
              guide={chunks[guideChunk]}
              error={chunkErrors[guideChunk] ?? ''}
              onRetry={() => request(guideChunk)}
              onPick={(row, time) => setFocus((current) => ({ ...current, row, time }))}
              onTune={(channelId) => { closeGuide(); tune(channelId); }}
            />}
          </div>
          <TvRemote onPress={act} onPower={onClose} muted={muted} guideOpen={guideOpen} hasLast={!!lastChannel} />
        </div>
        <p className="hint">CH± or ▲▼ change channel · digits tune · R last channel · G guide · I info · M mute · F full screen · Back stops. Watching counts as a viewer in Tunarr.</p>
      </section>
    </div>
  );
}
