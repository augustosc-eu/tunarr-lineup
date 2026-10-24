'use client';

import type { RemoteAction } from '../../lib/tvRemote';

type Props = {
  onPress: (action: RemoteAction) => void;
  onPower: () => void;
  muted: boolean;
  guideOpen: boolean;
  /** Whether there's a channel to go back to. */
  hasLast: boolean;
};

type Key = { label: string; name: string; action: RemoteAction; className?: string };

const digits: Key[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => ({ label: String(digit), name: `Digit ${digit}`, action: { kind: 'digit', digit } }));

/**
 * An on-screen remote beside the picture, for a mouse or a touch screen. Every
 * button does what the same key does on a real remote or a keyboard, so it's a
 * convenience, never the only way to do something.
 */
export function TvRemote({ onPress, onPower, muted, guideOpen, hasLast }: Props) {
  const key = ({ label, name, action, className = '' }: Key, extra: { pressed?: boolean; disabled?: boolean } = {}) => (
    <button key={name} type="button" className={`remote-key ${className}`} aria-label={name} title={name} aria-pressed={extra.pressed} disabled={extra.disabled} onClick={() => onPress(action)}>{label}</button>
  );
  return (
    <aside className={`tv-remote ${guideOpen ? 'guide-open' : ''}`} aria-label="Remote control">
      <div className="remote-top">
        <button type="button" className="remote-key power" aria-label="Power off (stop watching)" title="Power off (stop watching)" onClick={onPower}>⏻</button>
        <span className="remote-led" aria-hidden="true" />
        {key({ label: 'MUTE', name: muted ? 'Unmute' : 'Mute', action: { kind: 'mute' }, className: 'small' }, { pressed: muted })}
        {key({ label: 'FULL', name: 'Full screen', action: { kind: 'fullscreen' }, className: 'small' })}
      </div>
      <div className="remote-pad" role="group" aria-label="Number pad">
        {digits.map((digit) => key(digit))}
        {key({ label: 'LAST', name: 'Last channel', action: { kind: 'last' }, className: 'small' }, { disabled: !hasLast })}
        {key({ label: '0', name: 'Digit 0', action: { kind: 'digit', digit: 0 } })}
        {key({ label: 'INFO', name: 'Info', action: { kind: 'info' }, className: 'small' })}
      </div>
      <div className="remote-row">
        {key({ label: 'GUIDE', name: guideOpen ? 'Close guide' : 'Guide', action: { kind: 'guide' }, className: 'pill guide-key' }, { pressed: guideOpen })}
        {key({ label: '▶❚❚', name: 'Play or pause', action: { kind: 'play' }, className: 'pill' })}
      </div>
      <div className="remote-dpad" role="group" aria-label="Arrows">
        {key({ label: '▲', name: guideOpen ? 'Up' : 'Channel up', action: { kind: 'up' }, className: 'up' })}
        {key({ label: '◀', name: 'Left', action: { kind: 'left' }, className: 'left' })}
        {key({ label: 'OK', name: 'OK', action: { kind: 'ok' }, className: 'ok' })}
        {key({ label: '▶', name: 'Right', action: { kind: 'right' }, className: 'right' })}
        {key({ label: '▼', name: guideOpen ? 'Down' : 'Channel down', action: { kind: 'down' }, className: 'down' })}
      </div>
      <div className="remote-rockers">
        <span className="rocker" role="group" aria-label="Volume">
          {key({ label: '+', name: 'Volume up', action: { kind: 'volume', direction: 1 } })}
          <small aria-hidden="true">VOL</small>
          {key({ label: '−', name: 'Volume down', action: { kind: 'volume', direction: -1 } })}
        </span>
        {key({ label: 'BACK', name: 'Back', action: { kind: 'back' }, className: 'small back-key' })}
        <span className="rocker" role="group" aria-label="Channel">
          {key({ label: '+', name: 'CH +', action: { kind: 'channel', direction: 1 } })}
          <small aria-hidden="true">CH</small>
          {key({ label: '−', name: 'CH −', action: { kind: 'channel', direction: -1 } })}
        </span>
      </div>
      <span className="remote-brand" aria-hidden="true">LINEUP</span>
    </aside>
  );
}
