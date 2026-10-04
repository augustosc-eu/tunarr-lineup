// Every built-in programming template, and how the gallery groups them.
import { NETWORK_TEMPLATES, REGIONS } from './networkTemplates';
import { GENERAL_TEMPLATES, type Template } from './templates';

export const BUILT_IN_TEMPLATES: Template[] = [...GENERAL_TEMPLATES, ...NETWORK_TEMPLATES];

/** Gallery filters: saved templates, general ones, then each country. */
export const TEMPLATE_GROUPS = ['All', 'My templates', 'General', ...REGIONS] as const;
export type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

export function inGroup(template: Template, group: TemplateGroup) {
  if (group === 'All') return true;
  if (group === 'My templates') return !!template.custom;
  if (group === 'General') return !template.custom && template.region === 'Anywhere';
  return !template.custom && template.region === group;
}

export const matchesSearch = (template: Template, text: string) => {
  const needle = text.trim().toLowerCase();
  return !needle || [template.name, template.inspiredBy, template.region, template.description].some((value) => value.toLowerCase().includes(needle));
};
