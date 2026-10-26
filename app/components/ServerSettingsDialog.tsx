'use client';

import { useEffect, useState } from 'react';
import { tunarrApi, type ConfigChanges, type ConfigView, type SettingsView } from '../../lib/tunarrClient';
import { CompatibilityPanel } from './CompatibilityPanel';
import { NotificationsPanel } from './NotificationsPanel';
import type { CompatibilityReport } from '../../lib/compatibility';
import { aiChanges, aiDraftOf, AiFieldsEditor, mediaDraftOf, MediaFieldsEditor, TunarrAddressField, type AiDraft, type MediaDraft } from './SetupWizard';

type Props = { onClose: () => void; onSaved?: () => void; onCompatibility?: (report: CompatibilityReport) => void };
type Value = number | boolean | string;
type Setting = SettingsView['editable'][number];

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const SOURCE_LABELS: Record<Setting['source'], string> = { saved: 'Saved here', env: 'From setup', default: 'Default' };
const UNITS: Partial<Record<Setting['kind'], string>> = { seconds: 'seconds', megabytes: 'MB' };
const shown = (setting: Setting, value: Value | null) => (value === null ? 'not set' : setting.kind === 'toggle' ? (value ? 'on' : 'off') : value === '' ? 'empty' : `${value}${UNITS[setting.kind] ? ` ${UNITS[setting.kind]}` : ''}`);
const sameAi = (a: AiDraft, b: AiDraft) => a.provider === b.provider && (a.model ?? '') === (b.model ?? '') && (a.baseUrl ?? '') === (b.baseUrl ?? '') && !a.apiKey;

/** Setup → Server Settings…: Tunarr, AI, the media folder and the sign-in (server/setup.ts), then the tuning settings (server/settings.ts). */
export function ServerSettingsDialog({ onClose, onSaved, onCompatibility }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // null while loading; false on a server configured only where it runs.
  const [config, setConfig] = useState<ConfigView | false | null>(null);
  const [tunarrUrl, setTunarrUrl] = useState('');
  const [ai, setAi] = useState<AiDraft>({ provider: '', keySet: false });
  const [media, setMedia] = useState<MediaDraft>({ dir: '', tunarrDir: '' });
  const [account, setAccount] = useState({ username: '', currentPassword: '', newPassword: '', confirm: '' });
  const [signedOut, setSignedOut] = useState(false);
  const [checks, setChecks] = useState(0);

  const showConfig = (loaded: ConfigView) => {
    setConfig(loaded);
    setTunarrUrl(loaded.tunarr.url);
    setAi(aiDraftOf(loaded));
    setMedia(mediaDraftOf(loaded));
    setAccount({ username: loaded.account.username, currentPassword: '', newPassword: '', confirm: '' });
  };

  useEffect(() => {
    let cancelled = false;
    tunarrApi.settings().then((loaded) => { if (!cancelled) setView(loaded); }).catch((reason) => { if (!cancelled) setError(errorText(reason)); });
    tunarrApi.serverConfig().then((loaded) => { if (!cancelled) showConfig(loaded); }).catch(() => { if (!cancelled) setConfig(false); });
    return () => { cancelled = true; };
  }, []);

  const valueOf = (setting: Setting) => (setting.key in draft ? draft[setting.key] : setting.value);
  const set = (key: string, value: Value) => setDraft((current) => ({ ...current, [key]: value }));
  const changes = Object.fromEntries(Object.entries(draft).filter(([key, value]) => view?.editable.find((setting) => setting.key === key)?.value !== value));
  const changed = Object.keys(changes).length > 0;

  const connectionChanges: ConfigChanges = {};
  if (config) {
    if (tunarrUrl.trim() !== config.tunarr.url) connectionChanges.tunarrUrl = tunarrUrl.trim();
    if (!sameAi(ai, aiDraftOf(config))) connectionChanges.ai = aiChanges(ai);
    if (media.dir.trim() !== config.media.dir || media.tunarrDir.trim() !== config.media.tunarrDir) connectionChanges.media = { dir: media.dir.trim(), tunarrDir: media.tunarrDir.trim() };
  }
  const connectionChanged = Object.keys(connectionChanges).length > 0;
  const accountChanged = !!config && (account.username.trim() !== config.account.username || !!account.newPassword);
  const accountError = !account.currentPassword ? 'Type your current password.' : account.newPassword && account.newPassword.length < 8 ? 'The new password needs at least 8 characters.' : account.newPassword !== account.confirm ? 'The two new passwords don’t match.' : '';

  const run = async (task: () => Promise<void>, done: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
      setNotice(done);
      onSaved?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const send = (values: Record<string, Value | null>, done: string) => run(async () => {
    setView(await tunarrApi.saveSettings(values));
    setDraft((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in values))));
  }, done);

  const saveConnection = () => run(async () => {
    showConfig(await tunarrApi.saveServerConfig(connectionChanges));
    // A new address is a different Tunarr: check it again (the panel remounts).
    if (connectionChanges.tunarrUrl !== undefined) setChecks((count) => count + 1);
    // The tuning settings fall back to these values, so show them again too.
    setView(await tunarrApi.settings());
  }, 'Connection settings saved. They apply right away.');

  const saveAccount = () => {
    if (accountError) return setError(accountError);
    return run(async () => {
      await tunarrApi.saveServerConfig({ account: { currentPassword: account.currentPassword, username: account.username.trim(), ...(account.newPassword ? { newPassword: account.newPassword } : {}) } });
      setSignedOut(true);
    }, 'Sign-in changed. Sign in again with the new details.');
  };

  const groups = view ? [...new Set(view.editable.map((setting) => setting.group))] : [];

  return (
    <div className="overlay" role="presentation">
      <section className="modal server-settings-modal" role="dialog" aria-modal="true" aria-labelledby="server-settings-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SETUP</p>
        <h2 id="server-settings-title">Server settings</h2>
        {config && <>
          <p className="subtle">Kept by the Lineup server in config.json in its data folder. Keys and passwords are never shown again.</p>
          <h3 className="section-title">Tunarr</h3>
          <TunarrAddressField value={tunarrUrl} onChange={setTunarrUrl} detect={tunarrApi.detectTunarr} test={tunarrApi.testTunarr} />
          {config.tunarr.credentials && <p className="subtle">The saved address includes a Tunarr user name and password. Typing a new address replaces them.</p>}
          <h3 className="section-title">AI programming assistant</h3>
          <AiFieldsEditor value={ai} onChange={setAi} />
          <h3 className="section-title">Media folder</h3>
          <MediaFieldsEditor value={media} onChange={setMedia} />
          <div className="dialog-actions">
            <button className="primary" disabled={!connectionChanged || busy} onClick={() => void saveConnection()}>{busy ? 'Saving…' : 'Save connection settings'}</button>
          </div>
          <h3 className="section-title">Notifications</h3>
          <NotificationsPanel view={config.notifications} onSaved={showConfig} />
          <h3 className="section-title">Sign-in</h3>
          <div className="setup-group">
            <label className="field"><span>User name</span><input aria-label="Sign-in user name" autoComplete="username" value={account.username} onChange={(event) => setAccount({ ...account, username: event.target.value })} /></label>
            <label className="field"><span>Current password</span><input type="password" aria-label="Current password" autoComplete="current-password" value={account.currentPassword} onChange={(event) => setAccount({ ...account, currentPassword: event.target.value })} /></label>
            <label className="field"><span>New password (empty: keep it)</span><input type="password" aria-label="New password" autoComplete="new-password" value={account.newPassword} onChange={(event) => setAccount({ ...account, newPassword: event.target.value })} /></label>
            {account.newPassword && <label className="field"><span>New password again</span><input type="password" aria-label="New password again" autoComplete="new-password" value={account.confirm} onChange={(event) => setAccount({ ...account, confirm: event.target.value })} /></label>}
          </div>
          <div className="dialog-actions">
            {signedOut
              ? <button className="primary" onClick={() => window.location.reload()}>Sign in again</button>
              : <button disabled={!accountChanged || busy} onClick={() => void saveAccount()}>Change sign-in</button>}
          </div>
        </>}
        <h3 className="section-title">Compatibility</h3>
        <p className="subtle">What the saved Tunarr can do for Lineup, from read-only checks. Nothing here changes Tunarr.</p>
        <CompatibilityPanel key={checks} onReport={onCompatibility} />
        {!view ? <p className="subtle">{error || 'Loading server settings…'}</p> : <>
          <h3 className="section-title">Tuning</h3>
          <p className="subtle">Changes here take effect right away and are kept by the Lineup server (settings.json in its data folder). They win over the value from setup until you reset them.</p>
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
                      <p className="subtle">{setting.help} <small className={`setting-source source-${setting.source}`}>{SOURCE_LABELS[setting.source]}</small>{setting.source === 'saved' && <> <small>· from setup: {shown(setting, setting.envValue)}</small></>}</p>
                      {setting.source === 'saved' && <button disabled={busy} aria-label={`Reset ${setting.label}`} onClick={() => void send({ [setting.key]: null }, `${setting.label} is back to ${setting.envValue === null ? 'its default' : 'the value from setup'}.`)}>Reset</button>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="dialog-actions">
            <button className="primary" disabled={!changed || busy} onClick={() => void send(changes, 'Settings saved.')}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
          <h3 className="section-title">Set where the server starts</h3>
          <p className="subtle">{view.restartNote}</p>
          <ul className="fixed-settings" aria-label="Settings set where the server starts">
            {view.fixed.map((item) => <li key={item.label}><span>{item.label}</span><b>{item.set ? 'Set' : 'Default'}</b></li>)}
          </ul>
        </>}
        {notice && <p className="subtle" role="status">{notice}</p>}
        {error && view && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
        <div className="dialog-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
