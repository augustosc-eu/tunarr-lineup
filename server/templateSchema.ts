// Programming template shape, shared by the browser (built-in templates, the
// template editor) and the companion (saved templates, AI-generated ones).
// Pure: no Node APIs. Everything a template carries is checked here before it
// is stored or handed to the browser, so a saved file or an AI reply can never
// smuggle in anything but a template.
import { RULE_FIELDS, rulesToFilter, type RuleSet } from './smartCollection.js';

export type AdLevel = 'none' | 'light' | 'standard' | 'heavy';
/** [start "HH:MM", role id, ad level (default standard)] */
export type Block = [string, string] | [string, string, AdLevel];
export type PlayOrder = 'next' | 'shuffle' | 'ordered_shuffle' | 'chronological' | 'alphanumeric';

export type TemplateRole = {
  id: string;
  label: string;
  hint: string;
  order: PlayOrder;
  /** A smart collection that usually fits. */
  suggest?: RuleSet;
};

export type AdStyle = {
  label: string;
  midRoll?: { everyMin: number; breakMin: number; maxBreaks: number; minProgramMin: number };
  commercialsAt: string[];
  promosAt: string[];
};

export const WEEKDAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];
/** Every day the same, or weekdays/Saturday/Sunday with optional single-weekday overrides (e.g. Monday-night football). */
export type TemplateDays = { all: Block[] } | ({ weekdays: Block[]; saturday: Block[]; sunday: Block[] } & Partial<Record<'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday', Block[]>>);

/** A source a role is pre-filled with (saved from a channel, or picked by the AI). */
export type RoleDefault = { key: string; label: string; template: Record<string, unknown> & { type: string } };

export type Template = {
  id: string;
  name: string;
  inspiredBy: string;
  /** Country for network-inspired templates, "Anywhere" for general ones. */
  region: string;
  description: string;
  ads: AdStyle;
  padMs: number;
  latenessMs: number;
  roles: TemplateRole[];
  days: TemplateDays;
  defaults?: Record<string, RoleDefault>;
  /** Saved by the user (editable), as opposed to built in. */
  custom?: boolean;
  updatedAt?: number;
};

export const AD_LEVELS: Record<AdLevel, string> = { none: 'No commercials', light: 'Light', standard: 'Standard', heavy: 'Heavy' };
export const ORDERS: PlayOrder[] = ['next', 'shuffle', 'ordered_shuffle', 'chronological', 'alphanumeric'];
const FILLER_PLACES = ['head', 'pre', 'post', 'tail', 'fallback', 'mid'];
const SOURCE_TYPES = ['movie', 'show', 'custom-show', 'filler', 'smart-collection', 'redirect'];
const PAD_VALUES = [1, 5, 10, 15, 30, 60].map((minutes) => (minutes === 1 ? 1 : minutes * 60_000));
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const MAX_ROLES = 40;
export const MAX_BLOCKS_PER_DAY = 96;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number) => (typeof value === 'string' && value.trim().length <= max ? value.trim() : null);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function checkBlocks(value: unknown, roles: Set<string>, label: string): Block[] | string {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS_PER_DAY) return `${label}: blocks must be a list.`;
  const seen = new Set<string>();
  const blocks: Block[] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return `${label}: each block is [start, role, ad level].`;
    const [at, role, level] = raw;
    if (typeof at !== 'string' || !TIME.test(at)) return `${label}: start times look like "21:00".`;
    if (seen.has(at)) return `${label}: two blocks start at ${at}.`;
    seen.add(at);
    if (typeof role !== 'string' || !roles.has(role)) return `${label}: block at ${at} uses an unknown role.`;
    if (level !== undefined && !(level in AD_LEVELS)) return `${label}: unknown ad level at ${at}.`;
    blocks.push(level === undefined || level === 'standard' ? [at, role] : [at, role, level as AdLevel]);
  }
  return blocks.sort((a, b) => a[0].localeCompare(b[0]));
}

/** Validates and normalizes a template from a file, the browser or an AI reply. */
export function validateTemplate(input: unknown): { template: Template } | { error: string } {
  if (!isObject(input)) return { error: 'A template must be an object.' };
  const name = text(input.name, 120);
  if (!name) return { error: 'The template needs a name (up to 120 characters).' };
  const id = typeof input.id === 'string' && ID.test(input.id) ? input.id : null;
  if (!id) return { error: 'The template id is not valid.' };
  const description = text(input.description ?? '', 1000) ?? null;
  const inspiredBy = text(input.inspiredBy ?? '', 200);
  const region = text(input.region ?? 'Anywhere', 60);
  if (description === null || inspiredBy === null || region === null) return { error: 'Description or labels are too long.' };

  if (!Array.isArray(input.roles) || !input.roles.length || input.roles.length > MAX_ROLES) return { error: `A template needs 1–${MAX_ROLES} roles.` };
  const roles: TemplateRole[] = [];
  for (const raw of input.roles) {
    if (!isObject(raw)) return { error: 'Each role must be an object.' };
    const roleId = typeof raw.id === 'string' && ID.test(raw.id) ? raw.id : null;
    const label = text(raw.label, 80);
    if (!roleId || !label) return { error: 'Each role needs an id and a label.' };
    if (roles.some((item) => item.id === roleId)) return { error: `Role "${roleId}" appears twice.` };
    const order = ORDERS.includes(raw.order as PlayOrder) ? (raw.order as PlayOrder) : 'shuffle';
    const role: TemplateRole = { id: roleId, label, hint: text(raw.hint ?? '', 200) ?? '', order };
    if (raw.suggest !== undefined && raw.suggest !== null) {
      const suggest = raw.suggest as RuleSet;
      const checked = rulesToFilter(suggest);
      if ('error' in checked) return { error: `Role "${label}": ${checked.error}` };
      if (!checked.filter) return { error: `Role "${label}": the suggestion needs at least one rule.` };
      role.suggest = { match: suggest.match, rules: suggest.rules.map((rule) => ({ ...rule })).filter((rule) => rule.field in RULE_FIELDS) };
    }
    roles.push(role);
  }
  const roleIds = new Set(roles.map((role) => role.id));

  if (!isObject(input.days)) return { error: 'The template needs a day plan.' };
  let days: TemplateDays;
  if ('all' in input.days) {
    const all = checkBlocks(input.days.all, roleIds, 'Every day');
    if (typeof all === 'string') return { error: all };
    if (!all.length) return { error: 'The day plan has no blocks.' };
    days = { all };
  } else {
    const week: Json = {};
    for (const key of ['weekdays', 'saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const) {
      const value = input.days[key];
      if (value === undefined) {
        if (key === 'weekdays' || key === 'saturday' || key === 'sunday') return { error: `The day plan needs ${key}.` };
        continue;
      }
      const blocks = checkBlocks(value, roleIds, key[0].toUpperCase() + key.slice(1));
      if (typeof blocks === 'string') return { error: blocks };
      week[key] = blocks;
    }
    days = week as TemplateDays;
  }

  const adsInput = isObject(input.ads) ? input.ads : {};
  const places = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((place): place is string => typeof place === 'string' && FILLER_PLACES.includes(place)))] : []);
  const ads: AdStyle = { label: text(adsInput.label ?? '', 200) ?? '', commercialsAt: places(adsInput.commercialsAt), promosAt: places(adsInput.promosAt) };
  if (isObject(adsInput.midRoll)) {
    const mid = adsInput.midRoll;
    if (!finite(mid.everyMin) || mid.everyMin < 2 || mid.everyMin > 120 || !finite(mid.breakMin) || mid.breakMin <= 0 || mid.breakMin > 20
      || !Number.isInteger(mid.maxBreaks) || (mid.maxBreaks as number) < 1 || (mid.maxBreaks as number) > 20 || !finite(mid.minProgramMin) || mid.minProgramMin < 0) {
      return { error: 'Mid-roll breaks need an interval (2–120 min), a length (up to 20 min), a maximum count and a minimum program length.' };
    }
    ads.midRoll = { everyMin: mid.everyMin, breakMin: mid.breakMin, maxBreaks: mid.maxBreaks as number, minProgramMin: mid.minProgramMin };
    if (!ads.commercialsAt.includes('mid')) ads.commercialsAt.push('mid');
  }

  const padMs = PAD_VALUES.includes(input.padMs as number) ? (input.padMs as number) : 1;
  const latenessMs = finite(input.latenessMs) && input.latenessMs >= 0 && input.latenessMs <= 8 * 3_600_000 ? Math.round(input.latenessMs) : 15 * 60_000;

  const template: Template = { id, name, inspiredBy, region, description, ads, padMs, latenessMs, roles, days };
  if (isObject(input.defaults)) {
    const defaults: Record<string, RoleDefault> = {};
    for (const [roleId, raw] of Object.entries(input.defaults)) {
      if (!roleIds.has(roleId) || !isObject(raw) || !isObject(raw.template)) continue;
      const key = text(raw.key, 200);
      const label = text(raw.label, 200);
      const type = raw.template.type;
      if (!key || !label || typeof type !== 'string' || !SOURCE_TYPES.includes(type)) continue;
      // Only plain source fields are kept; Tunarr validates the rest on preview.
      const kept: RoleDefault['template'] = { type };
      for (const field of ['showId', 'customShowId', 'fillerListId', 'smartCollectionId', 'channelId', 'channelName', 'order', 'direction', 'seasonFilter', 'seasonExcludeFilter', 'durationWeighting', 'decayFactor', 'recoveryFactor']) {
        if (raw.template[field] !== undefined) kept[field] = raw.template[field];
      }
      for (const field of ['show', 'customShow', 'fillerList', 'smartCollection', 'channel']) {
        const value = raw.template[field];
        if (isObject(value)) kept[field] = Object.fromEntries(Object.entries(value).filter(([key, item]) => ['title', 'name', 'mediaSourceId', 'libraryId'].includes(key) && typeof item === 'string'));
      }
      defaults[roleId] = { key, label, template: kept };
    }
    if (Object.keys(defaults).length) template.defaults = defaults;
  }
  if (input.custom === true) template.custom = true;
  if (finite(input.updatedAt)) template.updatedAt = input.updatedAt;
  return { template };
}
