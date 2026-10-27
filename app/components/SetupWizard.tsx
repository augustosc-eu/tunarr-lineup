'use client';

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { tunarrApi, type AiFields, type ConfigView, type Probe } from '../../lib/tunarrClient';
import { versionLine } from '../../lib/compatibility';

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');

// ------------------------------------------------- fields shared with Server Settings

type Found = { found: Probe[]; tried: string[] };

/** "Tunarr 1.3.1 · everything Lineup uses answers", or what's missing (server/compatibility.ts). */
function compatibilityNote(summary: NonNullable<Extract<Probe, { ok: true }>['compatibility']>) {
  const missing = summary.unavailable ? `${summary.unavailable} feature${summary.unavailable === 1 ? '' : 's'} not available` : '';
  const odd = summary.degraded ? `${summary.degraded} answering unexpectedly` : '';
  const problems = [missing, odd].filter(Boolean).join(', ');
  return `${versionLine(summary.version, summary.versionStatus)} · ${problems ? `${problems} (see Server Settings → Compatibility after setup)` : 'everything Lineup uses answers'}.`;
}

/** Tunarr's address: places Lineup found it, or typed, and a test through the Lineup server. */
export function TunarrAddressField({ value, onChange, detect, test, autoDetect, onTested }: {
  value: string; onChange: (url: string) => void;
  detect: () => Promise<Found>; test: (url: string) => Promise<Probe>;
  autoDetect?: boolean; onTested?: (probe: Probe | null) => void;
}) {
  const [found, setFound] = useState<Found | null>(null);
  const [searching, setSearching] = useState(!!autoDetect);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Probe | null>(null);
  const [error, setError] = useState('');
  // What's in the field when a search ends: a found Tunarr fills it only if it's still empty.
  const current = useRef(value);
  useEffect(() => { current.current = value; }, [value]);

  const showFound = (next: Found) => {
    setFound(next);
    if (!current.current.trim() && next.found[0]) pick(next.found[0]);
  };
  const search = () => {
    setSearching(true);
    setError('');
    detect().then(showFound, (reason) => setError(errorText(reason))).finally(() => setSearching(false));
  };
  const pick = (probe: Probe) => {
    onChange(probe.url);
    setResult(probe);
    onTested?.(probe);
  };
  const runTest = async () => {
    setTesting(true);
    setError('');
    try {
      const probe = await test(value);
      // Shown as the server read it (http:// added, no trailing slash).
      if (probe.ok && probe.url && probe.url !== value) onChange(probe.url);
      setResult(probe);
      onTested?.(probe);
    } catch (reason) {
      setResult(null);
      onTested?.(null);
      setError(errorText(reason));
    } finally {
      setTesting(false);
    }
  };

  useEffect(() => {
    if (!autoDetect) return;
    let cancelled = false;
    detect().then((next) => { if (!cancelled) showFound(next); }, (reason) => { if (!cancelled) setError(errorText(reason)); }).finally(() => { if (!cancelled) setSearching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="setup-tunarr">
      <div className="setup-found" aria-live="polite">
        {searching ? <p className="subtle">Looking for Tunarr…</p>
          : found && (found.found.length
            ? <><p className="subtle">Found Tunarr at:</p>{found.found.map((probe) => (
              <button key={probe.url} type="button" className={probe.url === value ? 'primary' : ''} aria-pressed={probe.url === value} onClick={() => pick(probe)}>
                {probe.url} <small>· {probe.ok ? `${probe.channelCount} channel${probe.channelCount === 1 ? '' : 's'}` : ''}</small>
              </button>
            ))}</>
            : <p className="subtle">No Tunarr answered at {found.tried.join(', ')}. Type its address below.</p>)}
        <button type="button" disabled={searching} onClick={search}>{searching ? 'Looking…' : found ? 'Look again' : 'Find Tunarr'}</button>
      </div>
      <label className="field"><span>Tunarr address</span>
        <input aria-label="Tunarr address" value={value} placeholder="http://192.168.1.20:8000" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          onChange={(event) => { onChange(event.target.value); setResult(null); onTested?.(null); }} />
      </label>
      <p className="subtle">As the Lineup server reaches it: in Docker Compose usually <code>http://tunarr:8000</code>. Only the Lineup server uses this address; your browser never contacts Tunarr.</p>
      <div className="setup-row">
        <button type="button" disabled={!value.trim() || testing} onClick={() => void runTest()}>{testing ? 'Testing…' : 'Test connection'}</button>
        {result && (result.ok
          ? <span className="setup-ok" role="status">✓ Tunarr answered with {result.channelCount} channel{result.channelCount === 1 ? '' : 's'}.{result.compatibility && <> {compatibilityNote(result.compatibility)}</>}</span>
          : <span className="setup-bad" role="status">{result.message}</span>)}
      </div>
      {error && <div className="warning" role="alert"><b>Couldn’t check</b><span>{error}</span></div>}
    </div>
  );
}

export type AiDraft = AiFields & { keySet: boolean };

export function AiFieldsEditor({ value, onChange }: { value: AiDraft; onChange: (next: AiDraft) => void }) {
  const set = (changes: Partial<AiDraft>) => onChange({ ...value, ...changes });
  return (
    <div className="setup-group">
      <label className="field"><span>AI provider</span>
        <select aria-label="AI provider" value={value.provider} onChange={(event) => set({ provider: event.target.value as AiDraft['provider'] })}>
          <option value="">None: no AI assistant</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI, or a compatible server (Ollama, LM Studio)</option>
        </select>
      </label>
      {value.provider && <>
        <label className="field"><span>API key{value.provider === 'openai' ? ' (not needed for a local server)' : ''}</span>
          <input type="password" aria-label="AI API key" autoComplete="off" value={value.apiKey ?? ''} placeholder={value.keySet ? 'Saved. Leave empty to keep it' : ''} onChange={(event) => set({ apiKey: event.target.value })} />
        </label>
        <label className="field"><span>Model{value.provider === 'anthropic' ? ' (empty: the default)' : ''}</span>
          <input aria-label="AI model" value={value.model ?? ''} placeholder={value.provider === 'anthropic' ? 'claude-sonnet-5-5' : 'llama3.1'} onChange={(event) => set({ model: event.target.value })} />
        </label>
        <label className="field"><span>Address (empty: the provider’s own)</span>
          <input aria-label="AI address" value={value.baseUrl ?? ''} inputMode="url" spellCheck={false} placeholder={value.provider === 'openai' ? 'http://ollama:11434/v1' : 'https://api.anthropic.com'} onChange={(event) => set({ baseUrl: event.target.value })} />
        </label>
      </>}
      <p className="subtle">The key stays on the Lineup server and is never shown again.</p>
    </div>
  );
}

/** What to send for AI: the key only when one was typed, so a saved key is kept. */
export function aiChanges(draft: AiDraft): AiFields {
  if (!draft.provider) return { provider: '' };
  return { provider: draft.provider, model: draft.model?.trim() ?? '', baseUrl: draft.baseUrl?.trim() ?? '', ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) };
}

export type MediaDraft = { dir: string; tunarrDir: string };

export function MediaFieldsEditor({ value, onChange }: { value: MediaDraft; onChange: (next: MediaDraft) => void }) {
  return (
    <div className="setup-group">
      <label className="field"><span>Upload folder on the Lineup server (empty: uploads off)</span>
        <input aria-label="Media folder" value={value.dir} placeholder="/media/lineup" spellCheck={false} onChange={(event) => onChange({ ...value, dir: event.target.value })} />
      </label>
      {value.dir.trim() && <label className="field"><span>The same folder as Tunarr sees it (empty: the same path)</span>
        <input aria-label="Media folder as Tunarr sees it" value={value.tunarrDir} placeholder="/media/lineup" spellCheck={false} onChange={(event) => onChange({ ...value, tunarrDir: event.target.value })} />
      </label>}
      <p className="subtle">Station IDs, commercials and promos uploaded from Setup → Filler Folders, and music videos and other videos uploaded from Setup → Local Videos, go here. The folder must already exist.</p>
    </div>
  );
}

export const aiDraftOf = (view: ConfigView): AiDraft => ({ provider: view.ai.provider as AiDraft['provider'], model: view.ai.model, baseUrl: view.ai.baseUrl, apiKey: '', keySet: view.ai.keySet });
export const mediaDraftOf = (view: ConfigView): MediaDraft => ({ dir: view.media.dir, tunarrDir: view.media.tunarrDir });

// ------------------------------------------------------------------ the wizard

const STEPS = ['Setup code', 'Tunarr', 'Sign-in', 'Extras', 'Finish'] as const;

/** The code the desktop app opens its window with: #setup=CODE. */
function codeFromAddress() {
  if (typeof window === 'undefined') return '';
  return /(?:^#|&)setup=([A-Za-z0-9-]{1,32})/.exec(window.location.hash)?.[1] ?? '';
}

/** First start: the Lineup server has no Tunarr address or account yet (server/setup.ts). */
export function SetupWizard({ onDemo }: { onDemo: () => void }) {
  const [step, setStep] = useState(0);
  const [code, setCode] = useState(codeFromAddress);
  const [busy, setBusy] = useState(() => !!codeFromAddress());
  const [error, setError] = useState('');
  const [tunarrUrl, setTunarrUrl] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [username, setUsername] = useState('lineup');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ai, setAi] = useState<AiDraft>({ provider: '', keySet: false });
  const [media, setMedia] = useState<MediaDraft>({ dir: '', tunarrDir: '' });
  const [scheduler, setScheduler] = useState(false);
  const [externalLogos, setExternalLogos] = useState(true);
  const [done, setDone] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const section = useRef<HTMLElement>(null);

  const showView = (view: ConfigView) => {
    setTunarrUrl(view.tunarr.url);
    setPrefilled(!!view.tunarr.url);
    if (view.account.username) setUsername(view.account.username);
    setAi(aiDraftOf(view));
    setMedia(mediaDraftOf(view));
    setScheduler(view.options.scheduler);
    setExternalLogos(view.options.externalLogos);
    setStep(1);
  };
  const unlock = (given: string) => {
    setBusy(true);
    setError('');
    tunarrApi.setup.unlock(given).then(showView, (reason) => setError(errorText(reason))).finally(() => setBusy(false));
  };

  useEffect(() => {
    // Taken out of the address, so it isn't kept in history or bookmarks.
    if (!code) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    tunarrApi.setup.unlock(code).then(showView, (reason) => setError(errorText(reason))).finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each step starts on its first field, for the remote.
  useEffect(() => {
    section.current?.querySelector<HTMLElement>('input, select, button.primary')?.focus();
  }, [step]);

  const passwordError = password.length < 8 ? 'At least 8 characters.' : password !== confirm ? 'The two passwords don’t match.' : '';
  const next = (event?: FormEvent) => {
    event?.preventDefault();
    setError('');
    if (step === 0) return unlock(code);
    if (step === 1 && !probe?.ok && !unverified) {
      setError(probe && !probe.ok ? probe.message : 'Test the connection first, or choose “Use it anyway”.');
      return;
    }
    if (step === 2 && passwordError) return setError(passwordError);
    if (step === 4) return void finish();
    setStep(step + 1);
  };
  const back = () => { setError(''); setStep(Math.max(1, step - 1)); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && step > 1 && !done) { event.preventDefault(); back(); }
  };

  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await tunarrApi.setup.finish({
        code, tunarrUrl: tunarrUrl.trim(), account: { username: username.trim(), password },
        ai: aiChanges(ai), media: { dir: media.dir.trim(), tunarrDir: media.tunarrDir.trim() }, options: { scheduler, externalLogos },
      });
      setDone(result.username);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay setup-overlay" role="presentation">
      <section ref={section} className="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" onKeyDown={onKeyDown}>
        <p className="eyebrow">SETUP</p>
        {done ? <>
          <h2 id="setup-title">Lineup is set up</h2>
          <p className="subtle">Everything is saved on the Lineup server. Your browser will now ask you to sign in: use <b>{done}</b> and the password you just chose. Other devices (a TV, a phone) sign in the same way.</p>
          <div className="dialog-actions"><button className="primary" autoFocus onClick={() => window.location.reload()}>Sign in</button></div>
        </> : <>
          <h2 id="setup-title">Set up Tunarr Lineup</h2>
          <ol className="setup-steps" aria-label="Setup steps">
            {STEPS.map((name, index) => <li key={name} aria-current={index === step ? 'step' : undefined} className={index < step ? 'done' : index === step ? 'current' : ''}>{name}</li>)}
          </ol>
          <form onSubmit={next} noValidate>
            {step === 0 && <>
              <p className="subtle">This copy of Lineup isn’t set up yet. To make sure it’s you, type the setup code the Lineup server printed when it started: run <code>docker logs tunarr-lineup</code>, or look in the terminal where it runs.</p>
              <label className="field"><span>Setup code</span>
                <input className="setup-code" aria-label="Setup code" value={code} placeholder="ABCDE-FGHJK" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} onChange={(event) => setCode(event.target.value)} />
              </label>
            </>}
            {step === 1 && <>
              <p className="subtle">{prefilled ? 'This address came from the server’s old settings. Test it, or change it.' : 'Lineup looked in the usual places. Pick one, or type the address.'}</p>
              <TunarrAddressField value={tunarrUrl} onChange={(url) => { setTunarrUrl(url); setUnverified(false); }} autoDetect={!prefilled}
                detect={() => tunarrApi.setup.detect(code)} test={(url) => tunarrApi.setup.test(code, url)} onTested={setProbe} />
              {probe && !probe.ok && <label className="setup-check"><input type="checkbox" checked={unverified} onChange={(event) => setUnverified(event.target.checked)} /> Use it anyway (Tunarr isn’t running yet)</label>}
            </>}
            {step === 2 && <>
              <p className="subtle">Lineup can rewrite your channels, so it always asks for a sign-in. The password is stored only as a salted hash.</p>
              <label className="field"><span>User name</span><input aria-label="User name" autoComplete="username" autoCapitalize="off" value={username} onChange={(event) => setUsername(event.target.value)} /></label>
              <label className="field"><span>Password (at least 8 characters)</span><input type="password" aria-label="Password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              <label className="field"><span>Password again</span><input type="password" aria-label="Password again" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></label>
            </>}
            {step === 3 && <>
              <p className="subtle">All optional, and all can be changed later under Setup → Server Settings.</p>
              <h3 className="section-title">AI programming assistant</h3>
              <AiFieldsEditor value={ai} onChange={setAi} />
              <h3 className="section-title">Media folder</h3>
              <MediaFieldsEditor value={media} onChange={setMedia} />
              <h3 className="section-title">Options</h3>
              <label className="setup-check"><input type="checkbox" checked={scheduler} onChange={(event) => setScheduler(event.target.checked)} /> Save planned changes on their date (Save Later, seasonal overlays)</label>
              <label className="setup-check"><input type="checkbox" checked={externalLogos} onChange={(event) => setExternalLogos(event.target.checked)} /> Load channel logos hosted on public websites</label>
            </>}
            {step === 4 && <>
              <p className="subtle">Lineup will save this on its server ({'config.json'} in its data folder) and ask you to sign in.</p>
              <div className="info-row"><span>Tunarr</span><b>{tunarrUrl.trim()}{probe?.ok ? ` · ${probe.channelCount} channels` : ' · not tested'}</b></div>
              <div className="info-row"><span>Sign-in</span><b>{username.trim()}</b></div>
              <div className="info-row"><span>AI</span><b>{ai.provider ? `${ai.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}${ai.model ? ` · ${ai.model}` : ''}` : 'Off'}</b></div>
              <div className="info-row"><span>Media folder</span><b>{media.dir.trim() || 'Off'}</b></div>
              <div className="info-row single"><span>Scheduled changes</span><b>{scheduler ? 'On' : 'Off'}</b></div>
            </>}
            {error && <div className="warning" role="alert"><b>{step === 0 ? 'Not unlocked' : 'Check this'}</b><span>{error}</span></div>}
            <div className="dialog-actions">
              {step === 0 && <button type="button" onClick={onDemo}>Use demo data</button>}
              {step > 1 && <button type="button" disabled={busy} onClick={back}>Back</button>}
              <button type="submit" className="primary" disabled={busy || (step === 0 && !code.trim()) || (step === 1 && !tunarrUrl.trim())}>
                {busy ? (step === 4 ? 'Saving…' : 'Checking…') : step === 4 ? 'Finish setup' : 'Next'}
              </button>
            </div>
          </form>
        </>}
      </section>
    </div>
  );
}
