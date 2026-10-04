'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Channel } from '../../lib/lineup';
import { catalogOptions, DAY_MS, draftFromSchedule, ORDER_LABELS, showOption, type ScheduleDraftState, type SlotCatalog, type SlotSchedule, type SourceOption } from '../../lib/schedule';
import { BUILT_IN_TEMPLATES, inGroup, matchesSearch, TEMPLATE_GROUPS, type TemplateGroup } from '../../lib/templateCatalog';
import { AD_LEVELS, blankTemplate, dayRows, daySegments, defaultSource, isWeekly, roleUsage, scheduleToTemplate, templateToDraft, type Template } from '../../lib/templates';
import { tunarrApi, type AiStatus } from '../../lib/tunarrClient';
import { describeRules } from '../../server/smartCollection';
import { LibraryBrowser } from './LibraryBrowser';
import { TemplateEditor } from './TemplateEditor';

export type TemplateTarget = { kind: 'current' } | { kind: 'new'; name: string; number: number };

type Props = {
  channels: Channel[];
  activeChannel: Channel | undefined;
  /** The active channel's programming has a generated schedule (time or random slots). */
  activeHasSchedule: boolean;
  catalog: SlotCatalog | null;
  onClose: () => void;
  /** Opens the resulting draft in the slot editor (after creating a channel when asked). */
  onApply: (draft: ScheduleDraftState, target: TemplateTarget, template: Template) => Promise<void>;
};

const SUGGEST = '__suggest__';
const LIBRARY_SHOW = '__library-show__';
const ROLE_COLORS = ['#c9d7ff', '#ffe0a8', '#c8f0c8', '#f6c4d4', '#d9ccf5', '#bfe8ec', '#f3d9b9', '#e1e1e1', '#d6efb1', '#f9cfa8', '#c4d4e8'];
const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const hour = (ms: number) => `${String(Math.floor(ms / 3_600_000) % 24).padStart(2, '0')}:${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}`;

/** Example prompts for the AI assistant. */
export const AI_EXAMPLES = [
  'A 90s Saturday-morning cartoon channel with toy commercials between shows',
  'Program this channel like Rai 1, with the 20:00 news and a prime-time Italian drama',
  'A Japanese late-night anime channel with short ad breaks every 7 minutes',
  'Telenovelas all afternoon and a big prime-time show, Telefe style',
  'A BBC One-style channel: news at six and ten, a soap at 19:30, Sunday-night drama',
  'Una cadena española con informativos a las 15:00 y 21:00 y concursos por la tarde',
  'A commercial-free movie channel with a different theme each night of the week',
  'Use what this channel already plays and give it a proper daily structure',
];

/** The day plan as coloured bars, one row per distinct day. */
export function DayGrid({ template }: { template: Pick<Template, 'days' | 'roles'> }) {
  const colors = new Map(template.roles.map((item, index) => [item.id, ROLE_COLORS[index % ROLE_COLORS.length]]));
  const names = new Map(template.roles.map((item) => [item.id, item.label]));
  return (
    <div className="day-grid" aria-label="Day plan">
      <div className="day-grid-row"><span /><div className="day-grid-ticks">{[0, 6, 12, 18].map((value) => <small key={value} style={{ left: `${(value / 24) * 100}%` }}>{String(value).padStart(2, '0')}:00</small>)}</div></div>
      {dayRows(template).map((row) => (
        <div className="day-grid-row" key={row.key}>
          <span>{row.label}</span>
          <div className="day-grid-bar">
            {daySegments(row.blocks).flatMap((segment) => {
              // Blocks that run past midnight are drawn in two parts.
              const parts = segment.end > DAY_MS ? [[segment.start, DAY_MS], [0, segment.end - DAY_MS]] : [[segment.start, segment.end]];
              return parts.map(([from, to], part) => (
                <span key={`${segment.start}-${part}`} className={`day-grid-block ads-${segment.level}`} title={`${hour(segment.start)} ${names.get(segment.roleId)} · ${AD_LEVELS[segment.level]} ads`}
                  style={{ left: `${(from / DAY_MS) * 100}%`, width: `${((to - from) / DAY_MS) * 100}%`, background: colors.get(segment.roleId) }}>
                  {to - from >= 2 * 3_600_000 ? names.get(segment.roleId) : ''}
                </span>
              ));
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

const guessList = (lists: Array<{ id: string; name: string }>, pattern: RegExp) => lists.find((list) => pattern.test(list.name))?.id ?? '';

/** "Show genre is Drama or Crime", without the playable-type rule every suggestion has. */
const suggestionText = (rules: NonNullable<Template['roles'][number]['suggest']>) => {
  const shown = rules.rules.filter((rule) => rule.field !== 'type');
  return shown.length ? describeRules({ ...rules, rules: shown }) : describeRules(rules);
};

type Editing = { template: Template; busy: boolean; error: string };

export function TemplatesDialog({ channels, activeChannel, activeHasSchedule, catalog, onClose, onApply }: Props) {
  const [saved, setSaved] = useState<Template[]>([]);
  const [drafts, setDrafts] = useState<Template[]>([]);
  const [savedError, setSavedError] = useState('');
  const [group, setGroup] = useState<TemplateGroup>('All');
  const [search, setSearch] = useState('');
  const [templateId, setTemplateId] = useState(BUILT_IN_TEMPLATES[0].id);
  const [view, setView] = useState<'template' | 'ai'>('template');
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [shows, setShows] = useState<Record<string, SourceOption>>({});
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [listChoice, setListChoice] = useState<Record<string, { commercials?: string; promos?: string }>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const fillerLists = useMemo(() => catalog?.fillerLists ?? [], [catalog]);
  const [target, setTarget] = useState<'current' | 'new'>(activeChannel ? 'current' : 'new');
  const nextNumber = channels.reduce((max, channel) => Math.max(max, channel.number), 0) + 1;
  const [newName, setNewName] = useState('');
  const [newNumber, setNewNumber] = useState(nextNumber);
  const [picking, setPicking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // AI assistant
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [prompt, setPrompt] = useState('');
  const [useLibrary, setUseLibrary] = useState(true);
  const [useChannel, setUseChannel] = useState(!!activeChannel);
  const [baseId, setBaseId] = useState('');
  const [generating, setGenerating] = useState(false);
  const [aiError, setAiError] = useState('');

  const loadSaved = useCallback(() => tunarrApi.savedTemplates().then((items) => { setSaved(items); setSavedError(''); }).catch((reason) => setSavedError(errorText(reason))), []);
  useEffect(() => { void loadSaved(); }, [loadSaved]);

  const all = useMemo(() => [...drafts, ...saved, ...BUILT_IN_TEMPLATES], [drafts, saved]);
  const template = all.find((item) => item.id === templateId) ?? BUILT_IN_TEMPLATES[0];
  const isDraftItem = (item: Template) => drafts.some((draft) => draft.id === item.id);
  const visible = all.filter((item) => (group === 'My templates' ? item.custom || isDraftItem(item) : inGroup(item, group) || (group === 'All' && isDraftItem(item))) && matchesSearch(item, search));
  const isDraft = isDraftItem(template);

  // How many programs each role's suggested collection would match, so empty suggestions aren't picked.
  const requested = useRef(new Set<string>());
  useEffect(() => {
    for (const item of template.roles) {
      const key = `${template.id}:${item.id}`;
      if (!item.suggest || requested.current.has(key)) continue;
      requested.current.add(key);
      tunarrApi.previewSmartCollection({ ...item.suggest, keywords: '' })
        .then((result) => setCounts((current) => ({ ...current, [key]: result.totalHits })))
        .catch(() => setCounts((current) => ({ ...current, [key]: null })));
    }
  }, [template]);

  const usage = roleUsage(template);
  const options = useMemo(() => catalogOptions([], catalog ?? { customShows: [], fillerLists: [], smartCollections: [], channels: [] }, activeChannel?.id).filter((option) => option.key !== 'flex'), [catalog, activeChannel]);
  const choiceFor = (roleId: string) => {
    const chosen = choices[`${template.id}:${roleId}`];
    if (chosen !== undefined) return chosen;
    const preset = template.defaults?.[roleId];
    if (preset) return preset.key;
    return counts[`${template.id}:${roleId}`] ? SUGGEST : '';
  };
  const choose = (roleId: string, value: string) => setChoices((current) => ({ ...current, [`${template.id}:${roleId}`]: value }));
  const lists = listChoice[template.id] ?? {};
  const commercialsId = lists.commercials ?? guessList(fillerLists, /commercial|comercial|\bads?\b|tanda|\bcm\b|anuncio|pubblicit|spot/i);
  const promosId = lists.promos ?? guessList(fillerLists, /promo|bumper|station|\bids?\b|ident|trailer|cortina/i);
  const setLists = (patch: { commercials?: string; promos?: string }) => setListChoice((current) => ({ ...current, [template.id]: { commercials: commercialsId, promos: promosId, ...patch } }));
  const filledRoles = template.roles.filter((item) => usage.has(item.id) && choiceFor(item.id));
  const toCreate = filledRoles.filter((item) => choiceFor(item.id) === SUGGEST);

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const sources: Record<string, SourceOption | undefined> = {};
      for (const item of filledRoles) {
        const choice = choiceFor(item.id);
        const preset = template.defaults?.[item.id];
        if (choice === SUGGEST && item.suggest) {
          // Reuse a collection made by an earlier run of the same template.
          const name = `${template.name} · ${item.label}`;
          const existing = catalog?.smartCollections.find((collection) => collection.name === name);
          const collection = existing ?? await tunarrApi.createSmartCollection({ name, keywords: '', ...item.suggest });
          sources[item.id] = { key: `smart-collection:${collection.id}`, label: name, template: { type: 'smart-collection', smartCollectionId: collection.id, smartCollection: { name }, order: item.order, direction: 'asc' } };
        } else if (preset && choice === preset.key) {
          sources[item.id] = defaultSource(preset);
        } else if (choice.startsWith('show:') && shows[`${template.id}:${item.id}`]) {
          sources[item.id] = shows[`${template.id}:${item.id}`];
        } else {
          sources[item.id] = options.find((option) => option.key === choice);
        }
      }
      const draft = templateToDraft(template, sources, { commercials: commercialsId || undefined, promos: promosId || undefined });
      await onApply(draft, target === 'new' ? { kind: 'new', name: newName.trim() || template.name, number: newNumber } : { kind: 'current' }, template);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const select = (id: string) => {
    setTemplateId(id);
    setView('template');
    setConfirmDelete(false);
    setMessage('');
  };

  const saveTemplate = async (next: Template) => {
    setEditing((current) => (current ? { ...current, busy: true, error: '' } : current));
    try {
      const stored = next.id && saved.some((item) => item.id === next.id) ? await tunarrApi.updateTemplate(next.id, next) : await tunarrApi.createTemplate({ ...next, id: undefined });
      await loadSaved();
      setDrafts((current) => current.filter((item) => item.id !== next.id));
      setEditing(null);
      select(stored.id);
      setMessage(`Saved “${stored.name}” to My templates.`);
    } catch (reason) {
      setEditing((current) => (current ? { ...current, busy: false, error: errorText(reason) } : current));
    }
  };

  const saveDraftAsIs = async () => {
    setBusy(true);
    try {
      const stored = await tunarrApi.createTemplate({ ...template, id: undefined, custom: undefined });
      await loadSaved();
      setDrafts((current) => current.filter((item) => item.id !== template.id));
      setChoices((current) => Object.fromEntries(Object.entries(current).map(([key, value]) => [key.replace(`${template.id}:`, `${stored.id}:`), value])));
      setListChoice((current) => ({ ...current, [stored.id]: current[template.id] ?? {} }));
      select(stored.id);
      setMessage(`Saved “${stored.name}” to My templates.`);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const fromChannel = async () => {
    if (!activeChannel) return;
    setBusy(true);
    setError('');
    try {
      const data = await tunarrApi.schedule(activeChannel.id);
      const schedule = data?.schedule as SlotSchedule | undefined;
      const converted = schedule ? scheduleToTemplate(draftFromSchedule(schedule), `${activeChannel.name} format`, `The format of CH ${activeChannel.number} ${activeChannel.name}.`) : null;
      if (!converted) throw new Error(schedule?.type === 'random' ? 'This channel uses random slots, which have no clock times. Only time-slot schedules can become templates.' : 'This channel has no time-slot schedule to save.');
      setEditing({ template: { ...converted, id: '' }, busy: false, error: '' });
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await tunarrApi.deleteTemplate(template.id);
      await loadSaved();
      select(BUILT_IN_TEMPLATES[0].id);
      setMessage('Template deleted.');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const openAi = () => {
    setView('ai');
    setAiError('');
    if (!ai) tunarrApi.aiStatus().then(setAi).catch((reason) => setAi({ enabled: false, message: errorText(reason) }));
  };

  const generate = async () => {
    setGenerating(true);
    setAiError('');
    try {
      const base = baseId ? all.find((item) => item.id === baseId) : undefined;
      const proposal = await tunarrApi.aiTemplate({ prompt: prompt.trim(), channelId: useChannel ? activeChannel?.id : undefined, includeLibrary: useLibrary, baseTemplate: base });
      setDrafts((current) => [proposal.template, ...current]);
      setListChoice((current) => ({ ...current, [proposal.template.id]: proposal.lists }));
      setNotes((current) => ({ ...current, [proposal.template.id]: proposal.notes }));
      select(proposal.template.id);
    } catch (reason) {
      setAiError(errorText(reason));
    } finally {
      setGenerating(false);
    }
  };

  const groupLabel = (value: TemplateGroup) => {
    const count = value === 'My templates' ? saved.length + drafts.length : all.filter((item) => inGroup(item, value)).length;
    return `${value} (${count})`;
  };

  return (
    <div className="overlay" role="presentation" onKeyDown={(event) => {
      // Back closes the nested library browser or editor without leaving the gallery.
      if ((picking || editing) && (event.key === 'Escape' || event.key === 'GoBack' || event.key === 'BrowserBack')) {
        event.stopPropagation();
        setPicking(null);
        setEditing(null);
      }
    }}>
      <section className="modal templates-modal" role="dialog" aria-modal="true" aria-labelledby="templates-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">PROGRAMMING TEMPLATES</p>
        <h2 id="templates-title">Programming templates</h2>
        <p className="subtle">Start a channel’s schedule from the way a kind of channel or a network lays out its day, from your own saved formats, or from a plan the AI writes for your library. Network templates follow a network’s style; they aren’t its official schedule.</p>
        <div className="lists-layout">
          <div className="lists-index">
            <div className="template-tools">
              <button className="wide primary" onClick={openAi}>Ask AI…</button>
              <button className="wide" onClick={() => setEditing({ template: { ...blankTemplate(), id: '' }, busy: false, error: '' })}>New template</button>
              <button className="wide" disabled={!activeChannel || !activeHasSchedule || busy} title={activeHasSchedule ? undefined : 'This channel has no slot schedule.'} onClick={() => void fromChannel()}>Save this channel’s format</button>
              <select aria-label="Template group" value={group} onChange={(event) => setGroup(event.target.value as TemplateGroup)}>
                {TEMPLATE_GROUPS.map((value) => <option key={value} value={value}>{groupLabel(value)}</option>)}
              </select>
              <input aria-label="Search templates" placeholder="Search templates" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <div className="candidate-list" role="listbox" aria-label="Templates">
              {!visible.length && <p className="subtle candidate-empty">{group === 'My templates' ? 'No saved templates yet.' : 'Nothing matches.'}</p>}
              {visible.map((item) => (
                <button key={item.id} role="option" aria-selected={item.id === templateId && view === 'template'} className={`list-entry ${item.id === templateId && view === 'template' ? 'active' : ''}`} onClick={() => select(item.id)}>
                  <b>{item.name}</b><small>{isDraftItem(item) ? 'AI draft, not saved · ' : item.custom ? 'My template · ' : ''}{item.inspiredBy} · {item.region}</small>
                </button>
              ))}
            </div>
            {savedError && <p className="slot-problem">{savedError}</p>}
          </div>

          {view === 'ai' ? <div className="lists-editor ai-panel">
            <h3 className="section-title">Ask AI to program a channel</h3>
            {ai === null && <p className="subtle">Checking the AI setup…</p>}
            {ai && !ai.enabled && <div className="warning"><b>AI isn’t set up</b><span>{ai.message} See the README for the settings (Anthropic, OpenAI or a local model with Ollama).</span></div>}
            {ai?.enabled && <p className="subtle">Uses {ai.provider === 'anthropic' ? 'Anthropic' : 'an OpenAI-compatible API'} ({ai.model}). Your prompt{useLibrary ? ', your show and movie titles and genres' : ''}{useChannel && activeChannel ? ', what this channel plays' : ''} and your list names are sent to it. Nothing is changed until you preview and save.</p>}
            <label className="field wide-field"><span>What should the channel be?</span><textarea aria-label="AI prompt" rows={4} maxLength={2000} value={prompt} placeholder="A 90s Saturday-morning cartoon channel…" onChange={(event) => setPrompt(event.target.value)} /></label>
            <div className="prompt-chips" role="group" aria-label="Example prompts">
              {AI_EXAMPLES.map((example) => <button key={example} onClick={() => setPrompt(example)}>{example}</button>)}
            </div>
            <div className="list-toolbar checks">
              <label><input type="checkbox" checked={useLibrary} onChange={(event) => setUseLibrary(event.target.checked)} /> Use my library (titles and genres)</label>
              <label><input type="checkbox" checked={useChannel && !!activeChannel} disabled={!activeChannel} onChange={(event) => setUseChannel(event.target.checked)} /> Use what {activeChannel ? `CH ${activeChannel.number}` : 'this channel'} plays now</label>
              <label>Start from <select aria-label="AI base template" value={baseId} onChange={(event) => setBaseId(event.target.value)}>
                <option value="">Nothing, a fresh plan</option>
                {all.filter((item) => !isDraftItem(item)).map((item) => <option key={item.id} value={item.id}>{item.name}{item.region !== 'Anywhere' ? ` (${item.region})` : ''}</option>)}
              </select></label>
            </div>
            {aiError && <div className="warning" role="alert"><b>No plan this time</b><span>{aiError}</span></div>}
            <div className="dialog-actions">
              <button onClick={() => setView('template')}>Back to templates</button>
              <span className="spacer" />
              <button className="primary" disabled={!ai?.enabled || generating || !prompt.trim()} onClick={() => void generate()}>{generating ? 'Writing the schedule… (up to a minute or two)' : 'Write the schedule'}</button>
            </div>
          </div> : <div className="lists-editor">
            <h3 className="section-title">{template.name}</h3>
            <p>{template.description}</p>
            <p className="subtle">{template.inspiredBy}. {isWeekly(template) ? 'Weekly schedule.' : 'The same plan every day.'} {template.ads.label ? `Commercials: ${template.ads.label}.` : ''}</p>
            {notes[template.id] && <div className="notice" role="note"><b>From the AI</b><span>{notes[template.id]}</span></div>}
            {message && <p className="subtle" role="status">{message}</p>}
            <div className="list-toolbar template-actions">
              {isDraft && <button className="primary" disabled={busy} onClick={() => void saveDraftAsIs()}>Save to My templates</button>}
              {template.custom
                ? <>
                  <button onClick={() => setEditing({ template, busy: false, error: '' })}>Edit…</button>
                  {confirmDelete
                    ? <><span className="subtle">Delete “{template.name}”?</span><button onClick={() => setConfirmDelete(false)}>Keep</button><button className="primary" disabled={busy} onClick={() => void remove()}>Delete</button></>
                    : <button onClick={() => setConfirmDelete(true)}>Delete…</button>}
                </>
                : <button onClick={() => setEditing({ template: { ...structuredClone(template), id: '', name: isDraft ? template.name : `My ${template.name}` }, busy: false, error: '' })}>{isDraft ? 'Edit before saving…' : 'Copy and edit…'}</button>}
            </div>
            <DayGrid template={template} />

            <h3 className="section-title">Fill the roles</h3>
            <div className="candidate-list role-list">
              {template.roles.filter((item) => usage.has(item.id)).map((item) => {
                const key = `${template.id}:${item.id}`;
                const count = counts[key];
                const choice = choiceFor(item.id);
                const show = shows[key];
                const preset = template.defaults?.[item.id];
                return (
                  <div className="candidate role-row" key={key}>
                    <span><b>{item.label}</b><small>{item.hint ? `${item.hint} · ` : ''}{usage.get(item.id)} {usage.get(item.id) === 1 ? 'block' : 'blocks'}{isWeekly(template) ? ' a week' : ' a day'} · {ORDER_LABELS[item.order]}</small></span>
                    <select aria-label={`${item.label} source`} value={choice} disabled={busy} onChange={(event) => {
                      if (event.target.value === LIBRARY_SHOW) { setPicking(item.id); return; }
                      choose(item.id, event.target.value);
                    }}>
                      <option value="">Leave out (the block before runs on)</option>
                      {preset && <option value={preset.key}>{preset.label}</option>}
                      {item.suggest && <option value={SUGGEST}>New smart collection{count === undefined ? ' (checking…)' : count === null ? '' : ` · ${count.toLocaleString('en')} ${count === 1 ? 'match' : 'matches'}`} · {suggestionText(item.suggest)}</option>}
                      {show && <option value={show.key}>{show.label}</option>}
                      <option value={LIBRARY_SHOW}>A show from the library…</option>
                      {options.filter((option) => option.key !== preset?.key).map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="settings-grid">
              <label className="field"><span>Commercials list</span><select aria-label="Commercials list" value={commercialsId} disabled={!template.ads.commercialsAt.length} onChange={(event) => setLists({ commercials: event.target.value })}>
                <option value="">{template.ads.commercialsAt.length ? 'No commercials' : 'This style has no commercials'}</option>
                {fillerLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select></label>
              <label className="field"><span>Promos & station IDs list</span><select aria-label="Promos list" value={promosId} onChange={(event) => setLists({ promos: event.target.value })}>
                <option value="">No promos</option>
                {fillerLists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
              </select></label>
              <label className="field"><span>Use it for</span><select aria-label="Use it for" value={target} onChange={(event) => setTarget(event.target.value as 'current' | 'new')}>
                {activeChannel && <option value="current">CH {activeChannel.number} {activeChannel.name} (replaces its schedule when you save)</option>}
                <option value="new">A new channel</option>
              </select></label>
              {target === 'new' && <>
                <label className="field"><span>New channel name</span><input aria-label="New channel name" value={newName} placeholder={template.name} onChange={(event) => setNewName(event.target.value)} /></label>
                <label className="field"><span>Number</span><input type="number" min={1} step={1} aria-label="New channel number" value={newNumber} onChange={(event) => setNewNumber(Math.round(Number(event.target.value)))} /></label>
              </>}
            </div>
            {!fillerLists.length && <p className="subtle">Create filler lists for commercials and promos in Lists → Filler Lists… to add breaks.</p>}
            {error && <div className="warning" role="alert"><b>Template not applied</b><span>{error}</span></div>}
            <div className="dialog-actions">
              <button onClick={onClose}>Cancel</button>
              <span className="spacer" />
              <button className="primary" disabled={busy || !filledRoles.length || (target === 'new' && channels.some((channel) => channel.number === newNumber))} onClick={() => void apply()}>
                {busy ? 'Working…' : toCreate.length ? `Create ${toCreate.length} smart ${toCreate.length === 1 ? 'collection' : 'collections'} and open the schedule` : 'Open the schedule'}
              </button>
            </div>
            {target === 'new' && channels.some((channel) => channel.number === newNumber) && <p className="slot-problem">Channel {newNumber} already exists.</p>}
          </div>}
        </div>
      </section>
      {picking && <LibraryBrowser
        title={`Choose a show for “${template.roles.find((item) => item.id === picking)?.label}”`}
        mode="show"
        onClose={() => setPicking(null)}
        onPick={(pick) => {
          if ('show' in pick) {
            const option = showOption(pick.show);
            const roleItem = template.roles.find((item) => item.id === picking);
            if (roleItem) option.template = { ...option.template, order: roleItem.order };
            setShows((current) => ({ ...current, [`${template.id}:${picking}`]: option }));
            choose(picking, option.key);
          }
          setPicking(null);
        }}
      />}
      {editing && <TemplateEditor initial={editing.template} busy={editing.busy} error={editing.error} onCancel={() => setEditing(null)} onSave={(next) => void saveTemplate(next)} />}
    </div>
  );
}
