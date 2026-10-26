'use client';

import { useEffect, useState } from 'react';
import { blockedCapabilities, blockedParts, diagnosticsFile, STATUS_LABELS, versionLine, type CompatibilityReport } from '../../lib/compatibility';
import { tunarrApi } from '../../lib/tunarrClient';

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const timeLabel = (ms: number) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(ms));

/** Downloads the diagnostics file (no address, no credentials: see diagnosticsFile). */
function exportDiagnostics(report: CompatibilityReport) {
  const blob = new Blob([`${JSON.stringify(diagnosticsFile(report), null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `tunarr-lineup-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Setup → Server Settings → Compatibility: Tunarr's version, the connection,
 * each capability with its state and reason, what the desk turns off, and the
 * diagnostics export. The checks are the companion's (read-only, cached 5 min);
 * Check again runs them now.
 */
export function CompatibilityPanel({ onReport }: { onReport?: (report: CompatibilityReport) => void }) {
  const [report, setReport] = useState<CompatibilityReport | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  const show = (next: CompatibilityReport) => {
    setReport(next);
    onReport?.(next);
  };

  useEffect(() => {
    let cancelled = false;
    tunarrApi.compatibility()
      .then((next) => { if (!cancelled) show(next); }, (reason) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    setBusy(true);
    setError('');
    tunarrApi.refreshCompatibility().then(show, (reason) => setError(errorText(reason))).finally(() => setBusy(false));
  };

  const blocked = blockedCapabilities(report);
  const partly = blockedParts(report);
  return (
    <div className="compatibility" aria-live="polite">
      {!report ? <p className="subtle">{error || 'Checking what this Tunarr can do…'}</p> : <>
        <div className="info-row"><span>Tunarr</span><b>{report.connected ? versionLine(report.version.tunarr, report.version.status) : report.configured ? 'Not connected' : 'Not set up'}</b></div>
        <div className="info-row"><span>Connection</span><b>{report.connected ? 'Connected' : report.connectionError ?? 'Not connected'}</b></div>
        <div className="info-row"><span>API description</span><b>{{ read: 'Read', missing: 'Not offered by this Tunarr', failed: 'Couldn’t be read', 'not-checked': 'Not checked' }[report.apiDescription]}</b></div>
        <div className="info-row"><span>Checked</span><b>{timeLabel(report.checkedAt)}</b></div>
        {report.connected && report.version.status !== 'validated' && <div className="warning" role="note"><b>{report.version.status === 'unvalidated' ? 'Version not validated' : 'Version unknown'}</b><span>{report.version.note}</span></div>}
        {blocked.length > 0 && <div className="warning" role="note"><b>Turned off in the desk</b><span>{blocked.map((item) => `${item.label} (${item.uses})`).join('; ')}. The rest keeps working.</span></div>}
        {partly.length > 0 && <div className="warning" role="note"><b>Partly turned off</b><span>{partly.map((item) => `${item.label}: ${item.parts.map((part) => part.label).join(', ')}`).join('; ')}. Those buttons are off; everything else in them works.</span></div>}
        <ul className="issue-list compatibility-list" aria-label="Capabilities">
          {report.capabilities.map((item) => (
            <li key={item.id}>
              <button type="button" className={`issue capability status-${item.status}`} aria-label={`${item.label}: ${STATUS_LABELS[item.status]}. ${item.reason}`}>
                <em className="issue-badge">{STATUS_LABELS[item.status]}</em>
                <span><b>{item.label}</b><small>{item.reason}</small><small>Used by: {item.uses}</small></span>
              </button>
            </li>
          ))}
        </ul>
      </>}
      {error && report && <div className="warning" role="alert"><b>Check failed</b><span>{error}</span></div>}
      <div className="dialog-actions">
        <button type="button" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check again'}</button>
        <button type="button" disabled={!report} onClick={() => report && exportDiagnostics(report)}>Export diagnostics</button>
      </div>
    </div>
  );
}
