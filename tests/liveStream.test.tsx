// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStream } from '../app/useLiveStream';

const player = vi.hoisted(() => ({ supported: true, loadSource: vi.fn(), attachMedia: vi.fn() }));
vi.mock('hls.js', () => {
  class Hls {
    static isSupported = () => player.supported;
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifestParsed' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    on() {}
    loadSource(source: string) { player.loadSource(source); }
    attachMedia(element: HTMLMediaElement) { player.attachMedia(element); }
    destroy() {}
  }
  return { default: Hls };
});

const CHANNEL = '5d0c1e8a-7b6a-4d4c-9e2f-0000000000aa';
const SOURCE = `/api/tunarr/channels/${CHANNEL}/stream.m3u8`;

function Player() {
  const video = useRef<HTMLVideoElement>(null);
  useLiveStream(video, CHANNEL);
  return <video ref={video} />;
}

beforeEach(() => {
  player.supported = true;
  player.loadSource.mockClear();
  player.attachMedia.mockClear();
  // Like current Chrome: the browser says it can play HLS itself.
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('maybe');
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useLiveStream', () => {
  it('plays through hls.js even when the browser claims native HLS', async () => {
    const { container } = render(<Player />);
    await waitFor(() => expect(player.loadSource).toHaveBeenCalledWith(SOURCE));
    expect(player.attachMedia).toHaveBeenCalledWith(container.querySelector('video'));
    expect(container.querySelector('video')?.getAttribute('src')).toBeNull();
  });

  it('falls back to native HLS where hls.js can’t run', async () => {
    player.supported = false;
    const { container } = render(<Player />);
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe(SOURCE));
    expect(player.loadSource).not.toHaveBeenCalled();
  });
});
