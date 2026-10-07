'use client';

import { KIND_LABELS, KIND_ORDER, type AirKind, type StripSegment } from '../../lib/airKinds';
import { clockTimecode, durationTimecode } from '../../lib/broadcast';

type Props = {
  segments: StripSegment[];
  from: number;
  to: number;
  now: number;
  totals: Partial<Record<AirKind, number>>;
  /** Jumps to the first row of a segment. The rows themselves stay the keyboard path. */
  onPick: (position: number) => void;
};

const HOURS = [0, 6, 12, 18, 24];

/**
 * The day at a glance, like a station log's bar: programs, breaks, IDs and
 * flex time in their colours, with the on-air point marked.
 */
export function DayStrip({ segments, from, to, now, totals, onPick }: Props) {
  const span = to - from;
  if (span <= 0 || !segments.length) return null;
  const total = Object.values(totals).reduce((sum, ms) => sum + (ms ?? 0), 0);
  const kinds = KIND_ORDER.filter((kind) => (totals[kind] ?? 0) > 0);
  const summary = kinds.map((kind) => `${KIND_LABELS[kind]} ${durationTimecode(totals[kind] ?? 0)}`).join(', ');
  return (
    <div className="day-strip" role="group" aria-label="Airtime this day">
      <div className="strip-bar" role="img" aria-label={`Day strip: ${summary}`}>
        {segments.map((segment) => (
          <span
            key={`${segment.start}-${segment.position}`}
            className={`strip-segment kind-${segment.kind}`}
            style={{ left: `${((segment.start - from) / span) * 100}%`, width: `${((segment.stop - segment.start) / span) * 100}%` }}
            title={`${clockTimecode(segment.start)}–${clockTimecode(segment.stop)} ${KIND_LABELS[segment.kind]}`}
            onClick={() => onPick(segment.position)}
          />
        ))}
        {now >= from && now < to && <i className="strip-now" style={{ left: `${((now - from) / span) * 100}%` }} aria-hidden="true" />}
      </div>
      <div className="strip-hours" aria-hidden="true">{HOURS.map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{String(hour % 24).padStart(2, '0')}</span>)}</div>
      <div className="day-totals">
        {kinds.map((kind) => <span key={kind} className={`total-chip kind-${kind}`}><i className="swatch" aria-hidden="true" /><b>{KIND_LABELS[kind]}</b> {durationTimecode(totals[kind] ?? 0)} <small>{total ? Math.round(((totals[kind] ?? 0) / total) * 100) : 0}%</small></span>)}
      </div>
    </div>
  );
}
