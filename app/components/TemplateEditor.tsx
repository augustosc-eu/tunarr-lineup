'use client';

import { useState } from 'react';
import { LATENESS_OPTIONS, ORDER_LABELS, PAD_OPTIONS } from '../../lib/schedule';
import { AD_LEVELS, AD_STYLES, dayRows, episodes, movies, videos, type AdLevel, type Block, type Template, type TemplateRole } from '../../lib/templates';
import type { RuleSet } from '../../server/smartCollection';
import { validateTemplate, type TemplateDays } from '../../server/templateSchema';
import { DayGrid } from './TemplatesDialog';

type Props = {
  /** The template to edit; `id` is empty for a new one. */
  initial: Template;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSave: (template: Template) => void;
};

type Kind = 'tv' | 'movies' | 'videos' | 'none' | 'custom';
const KIND_LABELS: Record<Kind, string> = { tv: 'TV episodes, by show genre', movies: 'Movies, by genre', videos: 'Music videos, by genre', none: 'No suggestion', custom: 'Custom rules (kept as they are)' };
const PLACES: Array<[string, string]> = [['pre', 'Before programs'], ['post', 'After programs'], ['head', 'Start of block'], ['tail', 'End of block'], ['mid', 'Inside programs']];
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;

/** Reads a role's suggestion back as "kind + genres" when it has one of the simple shapes. */
function readSuggestion(suggest?: RuleSet): { kind: Kind; genres: string } {
  if (!suggest) return { kind: 'none', genres: '' };
  const [type, genre, ...rest] = suggest.rules;
  if (rest.length || suggest.match !== 'all' || type?.field !== 'type' || type.op !== 'is') return { kind: 'custom', genres: '' };
  const values = genre?.values?.join(', ') ?? '';
  if (type.values?.length === 1 && type.values[0] === 'episode' && genre?.field === 'show_genre' && genre.op === 'is') return { kind: 'tv', genres: values };
  if (type.values?.length === 1 && type.values[0] === 'movie' && (!genre || (genre.field === 'genre' && genre.op === 'is'))) return { kind: 'movies', genres: values };
  if (type.values?.includes('music_video') && (!genre || (genre.field === 'genre' && genre.op === 'is'))) return { kind: 'videos', genres: values };
  return { kind: 'custom', genres: '' };
}

function buildSuggestion(kind: Kind, genres: string, previous?: RuleSet): RuleSet | undefined {
  const list = genres.split(',').map((genre) => genre.trim()).filter(Boolean);
  if (kind === 'tv') return list.length ? episodes(...list) : { match: 'all', rules: [{ field: 'type', op: 'is', values: ['episode'] }] };
  if (kind === 'movies') return movies(...list);
  if (kind === 'videos') return videos(...list);
  if (kind === 'custom') return previous;
  return undefined;
}

const nextRoleId = (roles: TemplateRole[]) => {
  let n = roles.length + 1;
  while (roles.some((role) => role.id === `role-${n}`)) n += 1;
  return `role-${n}`;
};

export function TemplateEditor({ initial, busy, error, onCancel, onSave }: Props) {
  const [template, setTemplate] = useState<Template>(() => structuredClone(initial));
  const [dayKey, setDayKey] = useState(() => dayRows(initial)[0].key);
  const [problem, setProblem] = useState('');
  const set = (patch: Partial<Template>) => setTemplate((current) => ({ ...current, ...patch }));
  const rows = dayRows(template);
  const row = rows.find((item) => item.key === dayKey) ?? rows[0];
  const mode = 'all' in template.days ? 'daily' : WEEKDAYS.some((key) => key in template.days) ? 'each' : 'weekly';

  const setDays = (days: TemplateDays) => set({ days });
  const setBlocks = (key: string, blocks: Block[]) => setDays({ ...template.days, [key]: blocks } as TemplateDays);
  const changeMode = (next: string) => {
    const days = template.days;
    const base = 'all' in days ? days.all : days.weekdays;
    if (next === 'daily') setDays({ all: base });
    else if (next === 'weekly') setDays({ weekdays: base, saturday: 'all' in days ? base : days.saturday, sunday: 'all' in days ? base : days.sunday });
    else setDays({ weekdays: base, saturday: 'all' in days ? base : days.saturday, sunday: 'all' in days ? base : days.sunday, ...Object.fromEntries(WEEKDAYS.map((key) => [key, 'all' in days ? base : (days as Record<string, Block[] | undefined>)[key] ?? base])) } as TemplateDays);
    setDayKey(next === 'daily' ? 'all' : next === 'each' ? 'monday' : 'weekdays');
  };

  const updateBlock = (index: number, next: Block) => setBlocks(row.key, row.blocks.map((block, i) => (i === index ? next : block)));
  const addBlock = () => {
    const used = new Set(row.blocks.map(([at]) => at));
    let hour = row.blocks.length ? (Number(row.blocks[row.blocks.length - 1][0].slice(0, 2)) + 1) % 24 : 6;
    while (used.has(`${String(hour).padStart(2, '0')}:00`)) hour = (hour + 1) % 24;
    setBlocks(row.key, [...row.blocks, [`${String(hour).padStart(2, '0')}:00`, template.roles[0].id]]);
  };

  const updateRole = (index: number, patch: Partial<TemplateRole>) => set({ roles: template.roles.map((role, i) => (i === index ? { ...role, ...patch } : role)) });
  const removeRole = (index: number) => {
    const id = template.roles[index].id;
    const strip = (blocks: Block[]) => blocks.filter(([, roleId]) => roleId !== id);
    const days = Object.fromEntries(Object.entries(template.days).map(([key, blocks]) => [key, strip(blocks as Block[])])) as TemplateDays;
    set({ roles: template.roles.filter((_, i) => i !== index), days });
  };
  const roleUses = (id: string) => Object.values(template.days).reduce((sum, blocks) => sum + (blocks as Block[]).filter(([, roleId]) => roleId === id).length, 0);

  const ads = template.ads;
  const setAds = (patch: Partial<Template['ads']>) => set({ ads: { ...ads, ...patch } });
  const togglePlace = (list: 'commercialsAt' | 'promosAt', place: string, on: boolean) => setAds({ [list]: on ? [...ads[list], place] : ads[list].filter((item) => item !== place) });

  const save = () => {
    const checked = validateTemplate({ ...template, id: template.id || 'new-template' });
    if ('error' in checked) {
      setProblem(checked.error);
      return;
    }
    setProblem('');
    onSave({ ...checked.template, id: template.id, defaults: template.defaults });
  };

  return (
    <div className="overlay" role="presentation">
      <section className="modal template-editor-modal" role="dialog" aria-modal="true" aria-labelledby="template-editor-title">
        <button className="modal-close" aria-label="Close" onClick={onCancel}>×</button>
        <p className="eyebrow">MY TEMPLATES</p>
        <h2 id="template-editor-title">{template.id ? 'Edit template' : 'New template'}</h2>
        <div className="settings-grid">
          <label className="field"><span>Name</span><input aria-label="Template name" value={template.name} onChange={(event) => set({ name: event.target.value })} /></label>
          <label className="field"><span>Inspired by</span><input aria-label="Inspired by" value={template.inspiredBy} onChange={(event) => set({ inspiredBy: event.target.value })} /></label>
          <label className="field"><span>Region</span><input aria-label="Region" value={template.region} onChange={(event) => set({ region: event.target.value })} /></label>
          <label className="field wide-field"><span>Description</span><input aria-label="Description" value={template.description} onChange={(event) => set({ description: event.target.value })} /></label>
        </div>

        <h3 className="section-title">Day plan</h3>
        <div className="list-toolbar">
          <label>Plan <select aria-label="Day plan type" value={mode} onChange={(event) => changeMode(event.target.value)}><option value="daily">The same every day</option><option value="weekly">Weekdays, Saturday and Sunday</option><option value="each">Each day of the week</option></select></label>
          <label>Start times <select aria-label="Start times" value={template.padMs} onChange={(event) => set({ padMs: Number(event.target.value) })}>{PAD_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Late start allowed <select aria-label="Late start allowed" value={template.latenessMs} onChange={(event) => set({ latenessMs: Number(event.target.value) })}>
            {LATENESS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            {!LATENESS_OPTIONS.some(([value]) => value === template.latenessMs) && <option value={template.latenessMs}>{Math.round(template.latenessMs / 60_000)} minutes</option>}
          </select></label>
        </div>
        <DayGrid template={template} />
        {rows.length > 1 && <div className="segmented tabs" role="tablist" aria-label="Day">
          {rows.map((item) => <button key={item.key} role="tab" aria-selected={item.key === row.key} className={item.key === row.key ? 'primary' : ''} onClick={() => setDayKey(item.key)}>{item.label}</button>)}
        </div>}
        <div className="candidate-list block-list" aria-label={`${row.label} blocks`}>
          {!row.blocks.length && <p className="subtle candidate-empty">No blocks yet.</p>}
          {row.blocks.map((block, index) => (
            <div className="candidate block-row" key={`${block[0]}-${index}`}>
              <input type="time" aria-label={`Block ${index + 1} start`} value={block[0]} onChange={(event) => { if (/^\d{2}:\d{2}$/.test(event.target.value)) updateBlock(index, [event.target.value, block[1], ...(block[2] ? [block[2]] : [])] as Block); }} />
              <select aria-label={`Block ${index + 1} role`} value={block[1]} onChange={(event) => updateBlock(index, [block[0], event.target.value, ...(block[2] ? [block[2]] : [])] as Block)}>
                {template.roles.map((role) => <option key={role.id} value={role.id}>{role.label}</option>)}
              </select>
              <select aria-label={`Block ${index + 1} ads`} value={block[2] ?? 'standard'} onChange={(event) => updateBlock(index, event.target.value === 'standard' ? [block[0], block[1]] : [block[0], block[1], event.target.value as AdLevel])}>
                {Object.entries(AD_LEVELS).map(([value, label]) => <option key={value} value={value}>{label} ads</option>)}
              </select>
              <button aria-label={`Remove block ${index + 1}`} onClick={() => setBlocks(row.key, row.blocks.filter((_, i) => i !== index))}>Remove</button>
            </div>
          ))}
        </div>
        <div className="list-toolbar"><button onClick={addBlock}>Add block</button><span className="subtle">A block runs until the next one starts.</span></div>

        <h3 className="section-title">Roles</h3>
        <div className="candidate-list role-editor-list">
          {template.roles.map((role, index) => {
            const suggestion = readSuggestion(role.suggest);
            return (
              <div className="candidate role-editor-row" key={role.id}>
                <input aria-label={`Role ${index + 1} name`} value={role.label} onChange={(event) => updateRole(index, { label: event.target.value })} />
                <input aria-label={`Role ${index + 1} hint`} value={role.hint} placeholder="What plays here" onChange={(event) => updateRole(index, { hint: event.target.value })} />
                <select aria-label={`Role ${index + 1} order`} value={role.order} onChange={(event) => updateRole(index, { order: event.target.value as TemplateRole['order'] })}>{Object.entries(ORDER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                <select aria-label={`Role ${index + 1} suggestion`} value={suggestion.kind} onChange={(event) => updateRole(index, { suggest: buildSuggestion(event.target.value as Kind, suggestion.genres, role.suggest) })}>
                  {(Object.keys(KIND_LABELS) as Kind[]).filter((kind) => kind !== 'custom' || suggestion.kind === 'custom').map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
                </select>
                {suggestion.kind !== 'none' && suggestion.kind !== 'custom'
                  ? <input aria-label={`Role ${index + 1} genres`} placeholder="Genres, comma separated" defaultValue={suggestion.genres} onBlur={(event) => updateRole(index, { suggest: buildSuggestion(suggestion.kind, event.target.value) })} />
                  : <span />}
                <button aria-label={`Remove role ${index + 1}`} disabled={template.roles.length < 2} title={roleUses(role.id) ? `Also removes its ${roleUses(role.id)} blocks` : undefined} onClick={() => removeRole(index)}>Remove</button>
              </div>
            );
          })}
        </div>
        <div className="list-toolbar"><button onClick={() => set({ roles: [...template.roles, { id: nextRoleId(template.roles), label: 'New role', hint: '', order: 'shuffle' }] })}>Add role</button></div>

        <h3 className="section-title">Commercials</h3>
        <div className="list-toolbar">
          <label>Start from <select aria-label="Commercial style" value="" onChange={(event) => { const style = AD_STYLES[event.target.value as keyof typeof AD_STYLES]; if (style) set({ ads: structuredClone(style) }); }}>
            <option value="">A market’s style…</option>
            {Object.entries(AD_STYLES).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}
          </select></label>
          <label><input type="checkbox" checked={!!ads.midRoll} onChange={(event) => setAds({ midRoll: event.target.checked ? { everyMin: 10, breakMin: 3, maxBreaks: 4, minProgramMin: 20 } : undefined, commercialsAt: event.target.checked ? [...new Set([...ads.commercialsAt, 'mid'])] : ads.commercialsAt.filter((place) => place !== 'mid') })} /> Breaks inside programs</label>
          {ads.midRoll && <>
            <label>every <input type="number" min={2} max={120} aria-label="Minutes between breaks" value={ads.midRoll.everyMin} onChange={(event) => setAds({ midRoll: { ...ads.midRoll!, everyMin: Number(event.target.value) } })} /> min</label>
            <label>of <input type="number" min={0.5} max={20} step={0.5} aria-label="Break length" value={ads.midRoll.breakMin} onChange={(event) => setAds({ midRoll: { ...ads.midRoll!, breakMin: Number(event.target.value) } })} /> min</label>
            <label>at most <input type="number" min={1} max={20} aria-label="Most breaks per program" value={ads.midRoll.maxBreaks} onChange={(event) => setAds({ midRoll: { ...ads.midRoll!, maxBreaks: Math.round(Number(event.target.value)) } })} /></label>
          </>}
        </div>
        <div className="list-toolbar checks">
          <span>Commercials play:</span>
          {PLACES.filter(([place]) => place !== 'mid').map(([place, label]) => <label key={place}><input type="checkbox" checked={ads.commercialsAt.includes(place)} onChange={(event) => togglePlace('commercialsAt', place, event.target.checked)} /> {label}</label>)}
        </div>
        <div className="list-toolbar checks">
          <span>Promos & idents play:</span>
          {PLACES.filter(([place]) => place !== 'mid').map(([place, label]) => <label key={place}><input type="checkbox" aria-label={`Promos ${label.toLowerCase()}`} checked={ads.promosAt.includes(place)} onChange={(event) => togglePlace('promosAt', place, event.target.checked)} /> {label}</label>)}
        </div>
        <label className="field wide-field"><span>Commercial style description</span><input aria-label="Commercial style description" value={ads.label} onChange={(event) => setAds({ label: event.target.value })} /></label>

        {(problem || error) && <div className="warning" role="alert"><b>Not saved</b><span>{problem || error}</span></div>}
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <span className="spacer" />
          <button className="primary" disabled={busy || !template.name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>
        </div>
      </section>
    </div>
  );
}
