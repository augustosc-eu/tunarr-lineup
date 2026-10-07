// Saved programming templates, kept by the companion in one JSON file
// (LINEUP_DATA_DIR/templates.json) so they're shared by every browser that
// uses this Lineup: the TV, a laptop, a phone. Tunarr still holds all channel
// data; the only other stored state is filler-list roles (fillerRoleStore.ts).
import { randomUUID } from 'node:crypto';
import { createJsonFile, StoreError } from './jsonFile.js';
import { validateTemplate, type Template } from './templateSchema.js';

export { StoreError };
export const MAX_SAVED_TEMPLATES = 300;
const FILE = 'templates.json';

export type TemplateStore = {
  readonly location: string;
  list(): Promise<Template[]>;
  /** Creates (no id, or an id not yet saved) or replaces a saved template. */
  save(template: Template): Promise<Template>;
  remove(id: string): Promise<boolean>;
};

export function createTemplateStore(dir: string): TemplateStore {
  const file = createJsonFile(dir, FILE, 'saved templates');

  async function read(): Promise<Template[]> {
    const data = await file.read();
    const items = Array.isArray((data as { templates?: unknown })?.templates) ? (data as { templates: unknown[] }).templates : [];
    return items.map((item) => validateTemplate(item)).flatMap((result) => ('template' in result ? [{ ...result.template, custom: true }] : []));
  }

  const write = (templates: Template[]) => file.write({ version: 1, templates });

  return {
    location: file.location,
    list: () => file.serialize(read),
    save: (template) => file.serialize(async () => {
      const templates = await read();
      const index = templates.findIndex((item) => item.id === template.id);
      if (index < 0 && templates.length >= MAX_SAVED_TEMPLATES) throw new StoreError(409, 'too_many_templates', `You can keep up to ${MAX_SAVED_TEMPLATES} templates.`);
      const saved: Template = { ...template, custom: true, updatedAt: Date.now() };
      if (index < 0) templates.push(saved);
      else templates[index] = saved;
      await write(templates);
      return saved;
    }),
    remove: (id) => file.serialize(async () => {
      const templates = await read();
      const next = templates.filter((item) => item.id !== id);
      if (next.length === templates.length) return false;
      await write(next);
      return true;
    }),
  };
}

/** A fresh id for a saved template ("my-…"), distinct from built-in ids. */
// Hex digits from a random UUID (the first 10 are all random), without Buffer typings.
export const newTemplateId = (prefix = 'my') => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
