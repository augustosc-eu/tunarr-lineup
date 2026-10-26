'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { dpadKey } from '../dpad';
import { epgEntries, epgIssues, toXmltv } from '../../lib/epg';
import type { GuideChannel } from '../../lib/guideGrid';
import type { Channel } from '../../lib/lineup';

type Props = {
  channels: Channel[];
  activeChannelId: string;
  now: number;
  /** The same guide loader as the guide grid (Tunarr's guide through the companion, or the demo projection). */
  loadGuide: (from: number, to: number) => Promise<GuideChannel[]>;
  onClose: () => void;
};

const back = (key: string) => key === 'Escape' || key === 'GoBack' || key === 'BrowserBack';
const clock = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
const MAX_ROWS = 200;

/**
 * View → Guide Preview: the hours ahead as guide apps will list them, from
 * Tunarr's own guide, with what looks wrong (holes, overlaps, unreadably short
 * entries, generic flex titles), and an XMLTV file of the preview to look at.
 * Tunarr builds and serves the real guide (D69).
 */
export function GuidePreviewDialog({ channels, activeChannelId, now, loadGuide, onClose }: Props) {
  const [channelId, setChannelId] = useState(activeChannelId || channels[0]?.id || '');
  const [hours, setHours] = useState(12);
  const [guide, setGuide] = useState<{ from: number; to: number; channels: GuideChannel[] } | null>(null);
  const [error, setError] = useState('');
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    const from = Math.floor(now / 60_000) * 60_000;
    const to = from + hours * 3_600_000;
    loadGuide(from, to).then((data) => { if (!cancelled) { setGuide({ from, to, channels: data }); setError(''); } }, (reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'Couldn’t load the guide.'); });
    return () => { cancelled = true; };
    // Read once per window, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hours, loadGuide]);

  useEffect(() => { sectionRef.current?.querySelector<HTMLElement>('select')?.focus(); }, []);

  const channel = channels.find((item) => item.id === channelId);
  const listed = guide?.channels.find((item) => item.id === channelId) ?? (channel ? { id: channel.id, number: channel.number, name: channel.name, programs: [] } : null);
  const settings = channel as (Channel & { guideMinimumDuration?: number; guideFlexTitle?: string }) | undefined;
  const issues = guide && listed ? epgIssues(listed, guide.from, guide.to, { minimumMs: settings?.guideMinimumDuration || undefined, flexTitle: settings?.guideFlexTitle || undefined }) : [];
  const entries = listed && guide ? epgEntries(listed).filter((entry) => entry.stop > guide.from && entry.start < guide.to) : [];

  const download = () => {
    if (!guide) return;
    const url = URL.createObjectURL(new Blob([toXmltv(guide.channels, guide.from, guide.to)], { type: 'application/xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `guide-preview-${new Date(guide.from).toISOString().slice(0, 10)}.xml`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (back(event.key)) { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    dpadKey(event, sectionRef.current);
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={onKeyDown}>
      <section ref={sectionRef} className="modal epg-modal" role="dialog" aria-modal="true" aria-labelledby="epg-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">GUIDE</p>
        <h2 id="epg-title">Guide preview</h2>
        <p className="subtle">How guide apps will list the hours ahead, from Tunarr’s own guide. Tunarr builds and serves the real guide (its XMLTV); Lineup only previews and checks it.</p>
        <div className="batch-options">
          <label className="field"><span>Channel</span><select aria-label="Channel to preview" value={channelId} onChange={(event) => setChannelId(event.target.value)}>
            {[...channels].sort((a, b) => a.number - b.number).map((item) => <option key={item.id} value={item.id}>CH {item.number} {item.name}</option>)}
          </select></label>
          <label className="field"><span>Hours ahead</span><select aria-label="Hours ahead" value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {[3, 6, 12, 24].map((value) => <option key={value} value={value}>{value} hours</option>)}
          </select></label>
        </div>
        {error && <div className="warning" role="alert"><b>Couldn’t load the guide</b><span>{error}</span></div>}
        {!guide && !error && <p className="subtle">Loading Tunarr’s guide…</p>}
        {guide && <>
          <ul className="room-findings" aria-label="Guide checks">
            {!issues.length && <li><span>Nothing looks wrong in these hours.</span></li>}
            {issues.map((issue, index) => <li key={index} className={`severity-${issue.severity}`}><em className="issue-badge">{issue.severity}</em><span><b>{issue.title}</b><small>{issue.detail}</small></span></li>)}
          </ul>
          <div className="epg-listing"><table className="planner-summary" aria-label="Listing">
            <thead><tr><th>Start</th><th>End</th><th>Title</th><th>Sub-title</th><th>Category</th></tr></thead>
            <tbody>{entries.slice(0, MAX_ROWS).map((entry) => <tr key={entry.start}><td>{clock(entry.start)}</td><td>{clock(entry.stop)}</td><td>{entry.title}</td><td>{entry.subtitle}</td><td>{entry.category}</td></tr>)}</tbody>
          </table></div>
        </>}
        <div className="dialog-actions">
          <button disabled={!guide} onClick={download}>Download XMLTV preview</button>
          <button className="primary" onClick={onClose}>Close</button>
        </div>
        <p className="hint">↑ ↓ move · Back closes</p>
      </section>
    </div>
  );
}
