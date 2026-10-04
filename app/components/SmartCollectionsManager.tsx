'use client';

import { useCallback, useEffect, useState } from 'react';
import type { NamedItem, SmartCollectionView } from '../../lib/library';
import { tunarrApi } from '../../lib/tunarrClient';
import { DATE_OPS, DATE_UNITS, NUMERIC_OPS, RULE_FIELDS, STRING_OPS, type Rule } from '../../server/smartCollection';

type Props = {
  onClose: () => void;
  /** Called after a collection is created, changed or deleted. */
  onChanged?: () => void;
};

type Editing = { id: string | null; name: string; match: 'all' | 'any'; rules: Rule[]; keywords: string; unsupported: string; loaded: boolean; hadFilter: boolean };
type Preview = { totalHits: number; sample: Array<{ id?: string; title: string; type?: string; year?: number }> };

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.');
const TYPE_NAMES: Record<string, string> = { movie: 'Movies', episode: 'Episodes', other_video: 'Other videos', music_video: 'Music videos', track: 'Music tracks' };

/** A fresh rule for `field`, with a sensible default comparison. */
function blankRule(field: string): Rule {
  const kind = RULE_FIELDS[field].kind;
  if (kind === 'numeric') return { field, op: '>=', value: field === 'year' ? 1990 : 0 };
  if (kind === 'date') return { field, op: 'inthelast', amount: 2, unit: 'week' };
  return { field, op: 'is', values: field === 'type' ? ['movie'] : [''] };
}

function RuleRow({ rule, index, onChange, onRemove }: { rule: Rule; index: number; onChange: (rule: Rule) => void; onRemove: () => void }) {
  const field = RULE_FIELDS[rule.field];
  const ops = field.kind === 'string' ? STRING_OPS : field.kind === 'numeric' ? NUMERIC_OPS : DATE_OPS;
  const label = `Rule ${index + 1}`;
  return (
    <div className="candidate rule-row">
      <select aria-label={`${label} field`} value={rule.field} onChange={(event) => onChange(blankRule(event.target.value))}>
        {Object.entries(RULE_FIELDS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
      </select>
      <select aria-label={`${label} comparison`} value={rule.op} onChange={(event) => onChange({ ...rule, op: event.target.value })}>
        {Object.entries(ops).map(([value, text]) => <option key={value} value={value}>{text}</option>)}
      </select>
      {field.kind === 'string' && (field.choices
        ? <select aria-label={`${label} value`} value={rule.values?.[0] ?? ''} onChange={(event) => onChange({ ...rule, values: [event.target.value] })}>
          {field.choices.map((choice) => <option key={choice} value={choice}>{TYPE_NAMES[choice] ?? choice}</option>)}
        </select>
        : <input aria-label={`${label} value`} placeholder={rule.op === 'is' || rule.op === 'is not' ? 'Comedy, Drama (comma for any of)' : 'Text'} value={(rule.values ?? []).join(', ')}
          onChange={(event) => onChange({ ...rule, values: rule.op === 'is' || rule.op === 'is not' ? event.target.value.split(',').map((value) => value.trimStart()) : [event.target.value] })} />)}
      {field.kind === 'numeric' && <span className="rule-numbers">
        <input type="number" min={0} aria-label={`${label} value`} value={String(rule.value ?? '')} onChange={(event) => onChange({ ...rule, value: Number(event.target.value) })} />
        {rule.op === 'between' && <>and <input type="number" min={0} aria-label={`${label} upper value`} value={String(rule.value2 ?? '')} onChange={(event) => onChange({ ...rule, value2: Number(event.target.value) })} /></>}
      </span>}
      {field.kind === 'date' && <span className="rule-numbers">
        <input type="number" min={1} step={1} aria-label={`${label} amount`} value={String(rule.amount ?? 1)} onChange={(event) => onChange({ ...rule, amount: Math.max(1, Math.round(Number(event.target.value))) })} />
        <select aria-label={`${label} unit`} value={rule.unit ?? 'week'} onChange={(event) => onChange({ ...rule, unit: event.target.value })}>
          {DATE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}s</option>)}
        </select>
      </span>}
      <button aria-label={`Remove ${label.toLowerCase()}`} onClick={onRemove}>Remove</button>
    </div>
  );
}

export function SmartCollectionsManager({ onClose, onChanged }: Props) {
  const [collections, setCollections] = useState<NamedItem[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(() => tunarrApi.smartCollections()
    .then((items) => setCollections([...items].sort((a, b) => a.name.localeCompare(b.name))))
    .catch((reason) => setError(errorText(reason))), []);
  useEffect(() => { void load(); }, [load]);

  const fromView = (view: SmartCollectionView): Editing => ({
    id: view.id, name: view.name, keywords: view.keywords, match: view.rules?.match ?? 'all', rules: view.rules?.rules ?? [], unsupported: view.rules ? '' : view.filterString || view.description, loaded: true,
    hadFilter: !view.rules || view.rules.rules.length > 0,
  });

  const select = async (item: NamedItem) => {
    setEditing({ id: item.id, name: item.name, match: 'all', rules: [], keywords: '', unsupported: '', loaded: false, hadFilter: false });
    setDirty(false);
    setPreview(null);
    setConfirmDelete(false);
    setError('');
    try {
      const view = await tunarrApi.smartCollection(item.id);
      setEditing((current) => (current?.id === item.id ? fromView(view) : current));
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  const change = (patch: Partial<Editing>) => {
    setEditing((current) => (current ? { ...current, ...patch } : current));
    setDirty(true);
    setPreview(null);
  };
  const cleanRules = (rules: Rule[]) => rules.map((rule) => (rule.values ? { ...rule, values: rule.values.map((value) => value.trim()).filter(Boolean) } : rule));

  const runPreview = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await tunarrApi.previewSmartCollection({ match: editing.match, rules: cleanRules(editing.rules), keywords: editing.keywords }));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const rules = { match: editing.match, rules: cleanRules(editing.rules) };
      // With no rules, an update leaves Tunarr's own search (or keyword-only collection) alone.
      const view = editing.id
        ? await tunarrApi.updateSmartCollection(editing.id, { name: editing.name, keywords: editing.keywords, ...(editing.rules.length ? rules : {}) })
        : await tunarrApi.createSmartCollection({ name: editing.name, keywords: editing.keywords, ...rules });
      setEditing(fromView(view));
      setDirty(false);
      await load();
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing?.id) return;
    setBusy(true);
    try {
      await tunarrApi.deleteSmartCollection(editing.id);
      setEditing(null);
      setConfirmDelete(false);
      await load();
      onChanged?.();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const hasCriteria = !!editing && (editing.rules.length > 0 || editing.keywords.trim().length > 0);
  // Tunarr can't drop every rule from a saved collection, so that edit isn't offered.
  const droppedAllRules = !!editing?.id && editing.hadFilter && !editing.unsupported && editing.rules.length === 0;
  const canSave = !!editing && editing.loaded && editing.name.trim().length > 0 && dirty && !busy && hasCriteria && !droppedAllRules;

  return (
    <div className="overlay" role="presentation">
      <section className="modal lists-modal" role="dialog" aria-modal="true" aria-labelledby="smart-title">
        <button className="modal-close" aria-label="Close" onClick={onClose}>×</button>
        <p className="eyebrow">SMART COLLECTIONS</p>
        <h2 id="smart-title">Smart collections</h2>
        <p className="subtle">A smart collection is a saved search, like “comedies from the 90s” or “movies added in the last month”. Slots can play one, and it keeps up with your libraries.</p>
        <div className="lists-layout">
          <div className="lists-index">
            <button className="wide primary" onClick={() => { setEditing({ id: null, name: '', match: 'all', rules: [blankRule('genre')], keywords: '', unsupported: '', loaded: true, hadFilter: false }); setDirty(true); setPreview(null); setConfirmDelete(false); }}>New smart collection</button>
            <div className="candidate-list" role="listbox" aria-label="Smart collections">
              {collections === null && <p className="subtle candidate-empty">Loading…</p>}
              {collections?.length === 0 && <p className="subtle candidate-empty">None yet.</p>}
              {collections?.map((item) => (
                <button key={item.id} role="option" aria-selected={editing?.id === item.id} className={`list-entry ${editing?.id === item.id ? 'active' : ''}`} onClick={() => void select(item)}><b>{item.name}</b></button>
              ))}
            </div>
          </div>
          <div className="lists-editor">
            {!editing ? <p className="subtle">Choose a smart collection to edit, or create a new one.</p> : !editing.loaded ? <p className="subtle">Loading…</p> : <>
              <label className="field"><span>Name</span><input aria-label="Collection name" value={editing.name} onChange={(event) => change({ name: event.target.value })} /></label>
              {editing.unsupported && <div className="warning"><b>Made in Tunarr with a search Lineup can’t edit</b><span>{editing.unsupported}. Rules you add here replace it when you save.</span></div>}
              <div className="list-toolbar">
                <label>Match <select aria-label="Match" value={editing.match} onChange={(event) => change({ match: event.target.value as 'all' | 'any' })}><option value="all">all</option><option value="any">any</option></select> of these rules</label>
              </div>
              <p className="subtle">Tip: Tunarr files TV genres under the show, so use “Show genre” for episodes, and add “Type is episode” or “Type is movie” so only playable programs match.</p>
              <div className="candidate-list rule-list">
                {!editing.rules.length && <p className="subtle candidate-empty">No rules. Add one, or match on keywords only.</p>}
                {editing.rules.map((rule, index) => (
                  <RuleRow key={index} rule={rule} index={index}
                    onChange={(next) => change({ rules: editing.rules.map((item, i) => (i === index ? next : item)) })}
                    onRemove={() => change({ rules: editing.rules.filter((_, i) => i !== index) })} />
                ))}
              </div>
              <div className="list-toolbar">
                <button onClick={() => change({ rules: [...editing.rules, blankRule('genre')] })}>Add rule</button>
                <label className="grow">Keywords <input aria-label="Keywords" placeholder="Optional free-text search" value={editing.keywords} onChange={(event) => change({ keywords: event.target.value })} /></label>
                <button disabled={busy || !hasCriteria} onClick={() => void runPreview()}>Preview matches</button>
              </div>
              {preview && <div className="smart-preview" role="status">
                <b>{preview.totalHits.toLocaleString('en')} {preview.totalHits === 1 ? 'match' : 'matches'}</b>
                {preview.sample.length > 0 && <span>{preview.sample.map((item) => (item.year ? `${item.title} (${item.year})` : item.title)).join(' · ')}{preview.totalHits > preview.sample.length ? ' …' : ''}</span>}
              </div>}
              {droppedAllRules && <p className="subtle">Keep at least one rule. Tunarr can’t remove every rule from a saved collection; create a new one for keywords only.</p>}
              {error && <div className="warning" role="alert"><b>Not saved</b><span>{error}</span></div>}
              <div className="dialog-actions">
                {editing.id && (confirmDelete
                  ? <><span className="subtle">Delete “{editing.name}”? Slots that play it will need a new source.</span><button onClick={() => setConfirmDelete(false)}>Keep</button><button className="primary" disabled={busy} onClick={() => void remove()}>Delete</button></>
                  : <button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete…</button>)}
                <span className="spacer" />
                <button className="primary" disabled={!canSave} onClick={() => void save()}>{busy ? 'Saving…' : editing.id ? 'Save changes' : 'Create collection'}</button>
              </div>
            </>}
          </div>
        </div>
        {!editing && error && <div className="warning" role="alert"><b>Couldn’t load</b><span>{error}</span></div>}
        <div className="dialog-actions"><button onClick={onClose}>{dirty ? 'Close without saving' : 'Done'}</button></div>
      </section>
    </div>
  );
}
