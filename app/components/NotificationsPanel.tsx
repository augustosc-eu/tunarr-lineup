'use client';

import { useState } from 'react';
import { tunarrApi, type ConfigView } from '../../lib/tunarrClient';

type Props = { view: ConfigView['notifications']; onSaved: (next: ConfigView) => void };
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const when = (ms: number) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/**
 * Server Settings → Notifications (D68): one webhook, off until an address is
 * saved. The address is write-only (only its host is shown again), events are
 * chosen one by one, names go out only when ticked, and a private-network
 * address (plain HTTP allowed) only with its own tick.
 */
export function NotificationsPanel({ view, onSaved }: Props) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(view.events);
  const [includeNames, setIncludeNames] = useState(view.includeNames);
  const [allowPrivate, setAllowPrivate] = useState(view.allowPrivate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = (clear = false) => run(async () => {
    const next = await tunarrApi.saveServerConfig({ notifications: { ...(clear ? { url: '' } : url.trim() ? { url: url.trim() } : {}), events, includeNames, allowPrivate } });
    setUrl('');
    onSaved(next);
    setNotice(clear ? 'Notifications are off.' : next.notifications.set ? `Notifications go to ${next.notifications.host}.` : 'Saved. Add a webhook address to turn them on.');
  });

  const test = () => run(async () => {
    const result = await tunarrApi.testNotification();
    setNotice(result.ok ? `Test sent (the webhook answered ${result.status}).` : `Test not delivered: ${result.error ?? `the webhook answered ${result.status}`}${result.attempts > 1 ? ` (${result.attempts} tries)` : ''}.`);
  });

  return (
    <div className="notifications">
      <div className="info-row"><span>Webhook</span><b>{view.set ? `On · ${view.host}` : 'Off'}</b></div>
      {view.problem && <div className="warning" role="note"><b>The saved address can’t be used</b><span>{view.problem}</span></div>}
      <label className="field"><span>{view.set ? 'New webhook address (empty: keep it)' : 'Webhook address (https://…)'}</span>
        <input aria-label="Webhook address" value={url} inputMode="url" autoCapitalize="off" spellCheck={false} placeholder="https://ntfy.sh/your-topic" onChange={(event) => setUrl(event.target.value)} /></label>
      <fieldset className="pick-lists batch-tasks"><legend>Send a message when</legend>
        {view.catalog.map((item) => <label key={item.id} className="check-toggle"><input type="checkbox" checked={events.includes(item.id)} onChange={(event) => setEvents((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))} /> {item.label}</label>)}
      </fieldset>
      <label className="check-toggle"><input type="checkbox" checked={includeNames} onChange={(event) => setIncludeNames(event.target.checked)} /> Include channel and change names (otherwise only channel numbers and counts)</label>
      <label className="check-toggle"><input type="checkbox" checked={allowPrivate} onChange={(event) => setAllowPrivate(event.target.checked)} /> The address is on my private network (allows http:// and other ports, only to an address that resolves to your private network alone; never this machine or link-local)</label>
      <p className="subtle">Messages are small JSON (schema tunarr-lineup.notification, version 1): the event, its severity, a sentence, the channel’s id and number, and counts. Never Tunarr’s address, error texts, viewers’ addresses or programming.</p>
      <div className="dialog-actions">
        {view.set && <button disabled={busy} onClick={() => void save(true)}>Turn off</button>}
        <button disabled={busy || !view.set} onClick={() => void test()}>Send a test</button>
        <button className="primary" disabled={busy} onClick={() => void save()}>Save notifications</button>
      </div>
      {view.recent.length > 0 && <ul className="room-findings" aria-label="Recent notifications">
        {view.recent.slice(0, 5).map((item) => <li key={`${item.event}-${item.at}`} className={item.ok ? '' : 'severity-warning'}><span><b>{when(item.at)} · {item.event}</b><small>{item.ok ? `Delivered (${item.status})` : `Not delivered: ${item.error ?? `HTTP ${item.status}`}`}{item.attempts > 1 ? ` after ${item.attempts} tries` : ''}</small></span></li>)}
      </ul>}
      {notice && <p className="subtle" role="status">{notice}</p>}
      {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
    </div>
  );
}
