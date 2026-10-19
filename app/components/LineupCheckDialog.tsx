'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AirKind } from '../../lib/airKinds';
import { checkLineup, DEFAULT_CHECK_SETTINGS, issueLines, type CheckSettings, type Issue } from '../../lib/lineupCheck';
import type { Channel, Instance, LineupItem, Programming } from '../../lib/lineup';
import { dateRange, projectDays, weekSummary } from '../../lib/weekLog';
import { tunarrApi, type Review } from '../../lib/tunarrClient';

type Props = {
  channel: Channel;
  channels: Channel[];
  lineup: LineupItem[];
  programs: Programming['programs'];
  /** Where the lineup's projection starts (the channel start, moved when keeping what's on air). */
  channelStart: number;
  date: string;
  kindOf: (row: Instance) => AirKind;
  live: boolean;
  channelFillerListIds: string[] | null;
  knownFillerListIds: Set<string> | null;
  aiEnabled: boolean;
  onJump: (issue: Issue) => void;
  onClose: () => void;
};

const SETTINGS_KEY = (channelId: string) => `lineup-check:${channelId}`;

/** Per-channel check settings, remembered in this browser (a convenience; the defaults are fine without it). */
export function loadCheckSettings(channelId: string): CheckSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY(channelId));
    if (!raw) return DEFAULT_CHECK_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CheckSettings>;
    return {
      maxCommercialMinutes: parsed.maxCommercialMinutes === null || typeof parsed.maxCommercialMinutes === 'number' ? parsed.maxCommercialMinutes : DEFAULT_CHECK_SETTINGS.maxCommercialMinutes,
      familyHours: parsed.familyHours && typeof parsed.familyHours.from === 'number' && typeof parsed.familyHours.to === 'number' ? parsed.familyHours : null,
      matureRatings: Array.isArray(parsed.matureRatings) ? parsed.matureRatings.filter((item): item is string => typeof item === 'string') : DEFAULT_CHECK_SETTINGS.matureRatings,
    };
  } catch {
    return DEFAULT_CHECK_SETTINGS;
  }
}

const SEVERITY_LABEL: Record<Issue['severity'], string> = { error: 'Problem', warning: 'Warning', info: 'Note' };
const when = (ms: number) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

export function LineupCheckDialog({ channel, channels, lineup, programs, channelStart, date, kindOf, live, channelFillerListIds, knownFillerListIds, aiEnabled, onJump, onClose }: Props) {
  const [range, setRange] = useState<1 | 7>(1);
  const [settings, setSettings] = useState<CheckSettings>(() => loadCheckSettings(channel.id));
  const [edges, setEdges] = useState<Array<{ from: string; to: string }> | undefined>(undefined);
  const [loadingEdges, setLoadingEdges] = useState(false);
  const [edgeError, setEdgeError] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState('');

  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_KEY(channel.id), JSON.stringify(settings));
    } catch {
      // Private mode or storage off: the settings just aren't remembered.
    }
  }, [channel.id, settings]);

  const days = useMemo(() => projectDays(lineup, channelStart, dateRange(date, range)), [lineup, channelStart, date, range]);
  const issues = useMemo(() => checkLineup({
    lineup, programs, rows: days.flatMap((day) => day.rows), kindOf, channelId: channel.id, channels, channelFillerListIds, knownFillerListIds, redirectEdges: edges, settings,
  }), [lineup, programs, days, kindOf, channel.id, channels, channelFillerListIds, knownFillerListIds, edges, settings]);
  const counts = { error: issues.filter((issue) => issue.severity === 'error').length, warning: issues.filter((issue) => issue.severity === 'warning').length, info: issues.filter((issue) => issue.severity === 'info').length };

  const loadEdges = () => {
    setLoadingEdges(true);
    setEdgeError('');
    tunarrApi.redirects()
      .then((result) => setEdges(result.edges))
      .catch((error) => setEdgeError(error instanceof Error ? error.message : 'Couldn’t read the other channels.'))
      .finally(() => setLoadingEdges(false));
  };

  const askAi = () => {
    setReviewing(true);
    setReviewError('');
    const week = projectDays(lineup, channelStart, dateRange(date, 7));
    tunarrApi.aiReview({ channelName: `CH ${channel.number} ${channel.name}`, summary: weekSummary(week, programs, kindOf), issues: issueLines(issues) })
      .then(setReview)
      .catch((error) => setReviewError(error instanceof Error ? error.message : 'The AI review failed.'))
      .finally(() => setReviewing(false));
  };

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal check-modal" role="dialog" aria-modal="true" aria-labelledby="check-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">CH {channel.number} · {channel.name.toUpperCase()}</p>
        <h2 id="check-title">Check lineup</h2>
        <p className="subtle">What a broadcaster would catch before air, in the lineup as it is now (including unsaved changes).</p>
        <div className="list-toolbar">
          <span className="segmented" role="radiogroup" aria-label="Range to check">
            <button role="radio" aria-checked={range === 1} className={range === 1 ? 'primary' : ''} onClick={() => setRange(1)}>This day</button>
            <button role="radio" aria-checked={range === 7} className={range === 7 ? 'primary' : ''} onClick={() => setRange(7)}>7 days</button>
          </span>
          <span className="check-counts" role="status">{issues.length ? `${counts.error} ${counts.error === 1 ? 'problem' : 'problems'}, ${counts.warning} ${counts.warning === 1 ? 'warning' : 'warnings'}, ${counts.info} ${counts.info === 1 ? 'note' : 'notes'}` : 'Nothing found.'}</span>
        </div>
        <ol className="issue-list" aria-label="Issues">
          {issues.map((issue) => (
            <li key={issue.id}>
              <button className={`issue severity-${issue.severity}`} disabled={issue.at === undefined && issue.lineupIndex === undefined} onClick={() => onJump(issue)}>
                <em className="issue-badge">{SEVERITY_LABEL[issue.severity]}</em>
                <span><b>{issue.title}</b><small>{issue.detail}</small></span>
                {issue.at !== undefined && <time>{when(issue.at)}</time>}
              </button>
            </li>
          ))}
          {!issues.length && <li className="issue-empty">No problems in {range === 1 ? 'this day' : 'these 7 days'}.</li>}
        </ol>

        <details className="check-settings">
          <summary>Check settings for this channel</summary>
          <div className="settings-grid">
            <label className="field"><span>Commercial minutes an hour (limit)</span>
              <input type="number" min={1} max={60} aria-label="Commercial minutes limit" disabled={settings.maxCommercialMinutes === null} value={settings.maxCommercialMinutes ?? 18} onChange={(event) => setSettings((current) => ({ ...current, maxCommercialMinutes: Math.max(1, Math.min(60, Math.round(Number(event.target.value)) || 1)) }))} />
            </label>
            <label className="check-toggle"><input type="checkbox" checked={settings.maxCommercialMinutes !== null} onChange={(event) => setSettings((current) => ({ ...current, maxCommercialMinutes: event.target.checked ? 18 : null }))} /> Check commercial load</label>
            <label className="check-toggle"><input type="checkbox" checked={!!settings.familyHours} onChange={(event) => setSettings((current) => ({ ...current, familyHours: event.target.checked ? { from: 6, to: 21 } : null }))} /> Flag mature ratings in family hours</label>
            {settings.familyHours && <>
              <label className="field"><span>Family hours from</span><input type="number" min={0} max={23} aria-label="Family hours from" value={settings.familyHours.from} onChange={(event) => setSettings((current) => ({ ...current, familyHours: { from: Math.max(0, Math.min(23, Math.round(Number(event.target.value)))), to: current.familyHours!.to } }))} /></label>
              <label className="field"><span>until</span><input type="number" min={1} max={24} aria-label="Family hours until" value={settings.familyHours.to} onChange={(event) => setSettings((current) => ({ ...current, familyHours: { from: current.familyHours!.from, to: Math.max(1, Math.min(24, Math.round(Number(event.target.value)))) } }))} /></label>
              <label className="field"><span>Mature ratings</span><input aria-label="Mature ratings" value={settings.matureRatings.join(', ')} onChange={(event) => setSettings((current) => ({ ...current, matureRatings: event.target.value.split(',').map((item) => item.trim()) }))} /></label>
            </>}
          </div>
          <p className="hint">Ratings come from your media server. Programs without one are never flagged.</p>
        </details>

        {live && <div className="list-toolbar">
          <span>{edges ? `Redirect loops checked across ${new Set(edges.flatMap((edge) => [edge.from, edge.to])).size || 'all'} channels.` : 'Redirect loops need every channel’s lineup.'}{edgeError && <b className="slot-problem"> {edgeError}</b>}</span>
          <button disabled={loadingEdges} onClick={loadEdges}>{loadingEdges ? 'Reading channels…' : edges ? 'Check again' : 'Check redirect loops'}</button>
        </div>}

        {live && aiEnabled && <div className="ai-review">
          <div className="list-toolbar">
            <span><b>AI review</b> of the next 7 days, with these findings. Read-only: it only suggests.</span>
            <button disabled={reviewing} onClick={askAi}>{reviewing ? 'Reviewing…' : review ? 'Ask again' : 'Ask AI for a review'}</button>
          </div>
          {reviewError && <div className="warning" role="alert"><b>No review</b><span>{reviewError}</span></div>}
          {review && <div className="review" role="region" aria-label="AI review">
            <p>{review.summary}</p>
            <ol>{review.suggestions.map((item, index) => <li key={index} className={`priority-${item.priority}`}><b>{item.title}</b> <small>{item.priority}</small><span>{item.detail}</span></li>)}</ol>
          </div>}
        </div>}

        <div className="dialog-actions"><button className="primary" onClick={onClose}>Done</button></div>
      </section>
    </div>
  );
}
