'use client';

import { useEffect, useState } from 'react';
import { tunarrApi, type SettingsView } from '../../lib/tunarrClient';

type Props = { onClose: () => void; onSaved?: () => void };
type Value = number | boolean | string;
type Setting = SettingsView['editable'][number];

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const SOURCE_LABELS: Record<Setting['source'], string> = { saved: 'Saved here', env: 'From .env', default: 'Default' };
const UNITS: Partial<Record<Setting['kind'], string>> = { seconds: 'seconds', megabytes: 'MB' };
const shown = (setting: Setting, value: Value | null) => (value === null ? 'not set' : setting.kind === 'toggle' ? (value ? 'on' : 'off') : value === '' ? 'empty' : `${value}${UNITS[setting.kind] ? ` ${UNITS[setting.kind]}` : ''}`);

/** Setup → Server Settings…: the companion's settings that aren't about security (server/settings.ts). */
export function ServerSettingsDialog({ onClose, onSaved }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let cancelled = false;
    tunarrApi.settings().then((loaded) => { if (!cancelled) setView(loaded); }).catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; };
  }, []);

  const valueOf = (setting: Setting) => (setting.key in draft ? draft[setting.key] : setting.value);
  const set = (key: string, value: Value) => setDraft((current) => ({ ...current, [key]: value }));
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => view?.editable.find((setting) => setting.key === key)?.value !== value));
  const changed = Object.keys(changes).length > 0;

  const send = async (values: Record<string, Value | null>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      setView(await tunarrApi.saveSettings(values));
      setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in values))));
      setNotice(done);
      onSaved?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const groups = view ? [...new Set(view.editable.map((setting) => setting.group))] : [];

  return (
    <div className="overlay" role="presentation">
      <section className="modal server-settings-modal" role="dialog" aria-modal="true" aria-labelledby="server-settings-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="server-settings-title">Server settings</h2>
        {!view ? <p className="subtle">{error || 'Loading server settings…'}</p> : <>
          <p className="subtle">Changes here take effect right away and are kept by the Lineup server (settings.json in its data folder). They win over the .env file until you go back to its value.</p>
          {groups.map((group) => (
            <div key={group}>
              <h3 className="section-title">{group}</h3>
              <div className="server-settings">
                {view.editable.filter((setting) => setting.group === group).map((setting) => {
                  const value = valueOf(setting);
                  const id = `setting-${setting.key}`;
                  return (
                    <div className="server-setting" key={setting.key}>
                      {setting.kind === 'toggle'
                        ? <label className="server-setting-control"><input id={id} type="checkbox" checked={!!value} onChange={(event) => set(setting.key, event.target.checked)} /> {setting.label}</label>
                        : <label className="field server-setting-control"><span>{setting.label}{UNITS[setting.kind] ? ` (${UNITS[setting.kind]})` : ''}</span>
                          {setting.kind === 'text'
                            ? <input id={id} value={String(value)} maxLength={setting.max} onChange={(event) => set(setting.key, event.target.value)} />
                            : <input id={id} type="number" min={setting.min} max={setting.max} step={1} value={Number(value)} onChange={(event) => set(setting.key, Math.round(Number(event.target.value)))} />}
                        </label>}
                      <p className="subtle">{setting.help} <small className={`setting-source source-${setting.source}`}>{SOURCE_LABELS[setting.source]}</small>{setting.source === 'saved' && <> <small>· .env: {shown(setting, setting.envValue)}</small></>}</p>
                      {setting.source === 'saved' && <button disabled={busy} aria-label={`Use the .env value for ${setting.label}`} onClick={() => void send({ [setting.key]: null }, `${setting.label} is back to ${setting.envValue === null ? 'its default' : 'the .env value'}.`)}>Use .env value</button>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <h3 className="section-title">Kept in .env</h3>
          <p className="subtle">{view.restartNote}</p>
          <ul className="fixed-settings" aria-label="Settings kept in .env">
            {view.fixed.map((item) => <li key={item.label}><span>{item.label}</span><b>{item.set ? 'Set' : 'Not set'}</b></li>)}
          </ul>
          {notice && <p className="subtle" role="status">{notice}</p>}
          {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
        </>}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={!changed || busy} onClick={() => void send(changes, 'Settings saved.')}>{busy ? 'Saving…' : 'Save settings'}</button>
        </div>
      </section>
    </div>
  );
}
