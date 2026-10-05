// Smart collections as simple rules ("Genre is Comedy", "Added in the last
// 2 weeks"). The companion turns rules into Tunarr's search filter tree, so the
// browser never sends a raw filter. Pure module: the browser imports the field
// table and `filterToRules` for display.

export type RuleKind = 'string' | 'numeric' | 'date';
export type RuleField = { label: string; key: string; kind: RuleKind; facet?: boolean; scale?: number; choices?: string[] };

/** Fields Lineup offers, keyed by Tunarr's search alias (shared/src/util/searchUtil.ts). */
export const RULE_FIELDS: Record<string, RuleField> = {
  genre: { label: 'Genre', key: 'genres.name', kind: 'string', facet: true },
  type: { label: 'Type', key: 'type', kind: 'string', facet: true, choices: ['movie', 'episode', 'other_video', 'music_video', 'track'] },
  rating: { label: 'Content rating', key: 'rating', kind: 'string', facet: true },
  studio: { label: 'Studio', key: 'studio.name', kind: 'string', facet: true },
  actor: { label: 'Actor', key: 'actors.name', kind: 'string', facet: true },
  director: { label: 'Director', key: 'director.name', kind: 'string', facet: true },
  writer: { label: 'Writer', key: 'writer.name', kind: 'string', facet: true },
  tags: { label: 'Tag', key: 'tags', kind: 'string', facet: true },
  title: { label: 'Title', key: 'title', kind: 'string' },
  show_title: { label: 'Show title', key: 'grandparent.title', kind: 'string' },
  show_genre: { label: 'Show genre', key: 'grandparent.genres', kind: 'string', facet: true },
  audio_language: { label: 'Audio language', key: 'audioLanguages', kind: 'string', facet: true },
  year: { label: 'Year', key: 'originalReleaseYear', kind: 'numeric' },
  minutes: { label: 'Length (minutes)', key: 'duration', kind: 'numeric', scale: 60_000 },
  season: { label: 'Season number', key: 'seasonIndex', kind: 'numeric' },
  added_date: { label: 'Added to library', key: 'addedAt', kind: 'date' },
  release_date: { label: 'Released', key: 'originalReleaseDate', kind: 'date' },
};

export const STRING_OPS: Record<string, string> = { is: 'is', 'is not': 'is not', contains: 'contains', 'not contains': 'doesn’t contain' };
export const NUMERIC_OPS: Record<string, string> = { '=': '=', '!=': '≠', '<': '<', '<=': '≤', '>': '>', '>=': '≥', between: 'between' };
export const DATE_OPS: Record<string, string> = { inthelast: 'in the last', notinthelast: 'not in the last' };
export const DATE_UNITS = ['day', 'week', 'month', 'year'] as const;

export type Rule = {
  field: string;
  op: string;
  /** String rules: one or more values (several values mean "any of"). */
  values?: string[];
  /** Numeric rules. */
  value?: number;
  value2?: number;
  /** Date rules. */
  amount?: number;
  unit?: string;
};
export type RuleSet = { match: 'all' | 'any'; rules: Rule[] };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const UNIT_MS: Record<string, number> = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
/** Own keys only, so "toString" or "constructor" never pass as a field or operator. */
const has = (table: object, key: unknown): key is string => typeof key === 'string' && Object.hasOwn(table, key);
const fieldOf = (name: unknown) => (has(RULE_FIELDS, name) ? RULE_FIELDS[name] : undefined);
const STRING_OP_NAMES: Record<string, string> = { '=': 'is', in: 'is', '!=': 'is not', 'not in': 'is not', contains: 'contains', 'not contains': 'not contains' };

function ruleToNode(rule: Rule, now: number): Json | string {
  const spec = fieldOf(rule.field);
  if (!spec) return `Unknown field "${String(rule.field).slice(0, 40)}".`;
  const label = spec.label;
  if (spec.kind === 'string') {
    const values = (rule.values ?? []).map((value) => (typeof value === 'string' ? value.trim() : '')).filter(Boolean);
    if (!values.length || values.length > 50 || values.some((value) => value.length > 200)) return `${label}: enter a value.`;
    if (!has(STRING_OPS, rule.op)) return `${label}: unsupported comparison.`;
    let op: string;
    if (rule.op === 'is') op = values.length > 1 ? 'in' : '=';
    else if (rule.op === 'is not') op = values.length > 1 ? 'not in' : '!=';
    else op = rule.op;
    if ((op === 'contains' || op === 'not contains') && values.length > 1) return `${label}: “contains” takes one value.`;
    return { type: 'value', fieldSpec: { key: spec.key, name: rule.field, op, type: spec.facet ? 'faceted_string' : 'string', value: values } };
  }
  if (spec.kind === 'numeric') {
    if (!has(NUMERIC_OPS, rule.op)) return `${label}: unsupported comparison.`;
    const scale = spec.scale ?? 1;
    if (!finite(rule.value) || rule.value < 0) return `${label}: enter a number.`;
    if (rule.op === 'between') {
      if (!finite(rule.value2) || rule.value2 < rule.value) return `${label}: the range needs a low and a high number.`;
      return { type: 'value', fieldSpec: { key: spec.key, name: rule.field, op: 'to', type: 'numeric', value: [rule.value * scale, rule.value2 * scale] } };
    }
    return { type: 'value', fieldSpec: { key: spec.key, name: rule.field, op: rule.op, type: 'numeric', value: rule.value * scale } };
  }
  if (!has(DATE_OPS, rule.op)) return `${label}: unsupported comparison.`;
  if (!Number.isInteger(rule.amount) || (rule.amount as number) < 1 || (rule.amount as number) > 1000) return `${label}: enter how many.`;
  if (!(DATE_UNITS as readonly unknown[]).includes(rule.unit)) return `${label}: choose days, weeks, months or years.`;
  // Tunarr stores the relative expression and resolves it again on every read.
  const resolved = now - (rule.amount as number) * UNIT_MS[rule.unit as string];
  return {
    type: 'value',
    fieldSpec: { key: spec.key, name: rule.field, op: rule.op === 'inthelast' ? '>=' : '<', type: 'date', value: resolved, relativeDate: { op: rule.op, amount: rule.amount, unit: rule.unit } },
  };
}

/** Tunarr's filter tree for a rule set, or an error to show the user. */
export function rulesToFilter(input: unknown, now = Date.now()): { filter: Json | null } | { error: string } {
  if (!isObject(input) || !Array.isArray(input.rules)) return { error: 'Send rules as { "match", "rules" }.' };
  if (input.match !== 'all' && input.match !== 'any') return { error: 'Match must be "all" or "any".' };
  if (input.rules.length > 30) return { error: 'Use at most 30 rules.' };
  const nodes: Json[] = [];
  for (const raw of input.rules) {
    if (!isObject(raw)) return { error: 'Each rule must be an object.' };
    const node = ruleToNode(raw as Rule, now);
    if (typeof node === 'string') return { error: node };
    nodes.push(node);
  }
  if (!nodes.length) return { filter: null };
  if (nodes.length === 1) return { filter: nodes[0] };
  return { filter: { type: 'op', op: input.match === 'any' ? 'or' : 'and', children: nodes } };
}

function nodeToRule(node: unknown): Rule | null {
  if (!isObject(node) || node.type !== 'value' || !isObject(node.fieldSpec)) return null;
  const spec = node.fieldSpec;
  const field = Object.entries(RULE_FIELDS).find(([alias, item]) => alias === spec.name || (item.key === spec.key && !spec.name))?.[0]
    ?? Object.entries(RULE_FIELDS).find(([, item]) => item.key === spec.key)?.[0];
  if (!field) return null;
  const meta = RULE_FIELDS[field];
  if (meta.kind === 'string') {
    if (!Array.isArray(spec.value)) return null;
    const op = has(STRING_OP_NAMES, spec.op) ? STRING_OP_NAMES[spec.op] : undefined;
    return op ? { field, op, values: spec.value.map(String) } : null;
  }
  if (meta.kind === 'numeric') {
    const scale = meta.scale ?? 1;
    if (spec.op === 'to' && Array.isArray(spec.value) && spec.value.length === 2) return { field, op: 'between', value: Number(spec.value[0]) / scale, value2: Number(spec.value[1]) / scale };
    return has(NUMERIC_OPS, spec.op) && finite(spec.value) ? { field, op: spec.op, value: spec.value / scale } : null;
  }
  const relative = spec.relativeDate;
  if (isObject(relative) && has(DATE_OPS, relative.op)) return { field, op: relative.op, amount: Number(relative.amount), unit: String(relative.unit) };
  return null;
}

/** Rules for a stored filter, or null when it uses something Lineup's editor can't show. */
export function filterToRules(filter: unknown): RuleSet | null {
  if (filter === undefined || filter === null) return { match: 'all', rules: [] };
  if (!isObject(filter)) return null;
  if (filter.type === 'value') {
    const rule = nodeToRule(filter);
    return rule ? { match: 'all', rules: [rule] } : null;
  }
  if (filter.type !== 'op' || !Array.isArray(filter.children)) return null;
  const rules: Rule[] = [];
  for (const child of filter.children) {
    const rule = nodeToRule(child);
    if (!rule) return null;
    rules.push(rule);
  }
  return { match: filter.op === 'or' ? 'any' : 'all', rules };
}

/** One-line description, e.g. "Genre is Comedy and Year ≥ 1990". */
export function describeRules(set: RuleSet) {
  const parts = set.rules.map((rule) => {
    const field = fieldOf(rule.field);
    if (!field) return rule.field;
    if (field.kind === 'string') return `${field.label} ${STRING_OPS[rule.op] ?? rule.op} ${(rule.values ?? []).join(' or ')}`;
    if (field.kind === 'numeric') return rule.op === 'between' ? `${field.label} ${rule.value}–${rule.value2}` : `${field.label} ${NUMERIC_OPS[rule.op] ?? rule.op} ${rule.value}`;
    return `${field.label} ${DATE_OPS[rule.op] ?? rule.op} ${rule.amount} ${rule.unit}${rule.amount === 1 ? '' : 's'}`;
  });
  return parts.join(set.match === 'any' ? ' or ' : ' and ');
}
