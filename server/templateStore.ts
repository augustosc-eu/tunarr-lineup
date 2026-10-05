// Saved programming templates, kept by the companion in one JSON file
// (LINEUP_DATA_DIR/templates.json) so they're shared by every browser that
// uses this Lineup: the TV, a laptop, a phone. This is the companion's only
// stored state; Tunarr still holds all channel data.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateTemplate, type Template } from './templateSchema.js';

export const MAX_SAVED_TEMPLATES = 300;
const FILE = 'templates.json';

export class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type TemplateStore = {
  readonly location: string;
  list(): Promise<Template[]>;
  /** Creates (no id, or an id not yet saved) or replaces a saved template. */
  save(template: Template): Promise<Template>;
  remove(id: string): Promise<boolean>;
};

export function createTemplateStore(dir: string): TemplateStore {
  const file = path.join(dir, FILE);
  // Writes are serialized so two saves can't interleave and lose one.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>) => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function read(): Promise<Template[]> {
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new StoreError(500, 'store_unreadable', 'Saved templates could not be read.');
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      // Never overwrite a file we can't parse; the user may want to recover it.
      throw new StoreError(500, 'store_corrupt', `The saved templates file (${FILE}) is not valid JSON. Fix or move it, then try again.`);
    }
    const items = Array.isArray((data as { templates?: unknown })?.templates) ? (data as { templates: unknown[] }).templates : [];
    return items.map((item) => validateTemplate(item)).flatMap((result) => ('template' in result ? [{ ...result.template, custom: true }] : []));
  }

  async function write(templates: Template[]) {
    try {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, templates }, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
    } catch {
      throw new StoreError(500, 'store_unwritable', `Templates could not be saved. Check that LINEUP_DATA_DIR (${dir}) is writable.`);
    }
  }

  return {
    location: file,
    list: () => serialize(read),
    save: (template) => serialize(async () => {
      const templates = await read();
      const index = templates.findIndex((item) => item.id === template.id);
      if (index < 0 && templates.length >= MAX_SAVED_TEMPLATES) throw new StoreError(409, 'too_many_templates', `You can keep up to ${MAX_SAVED_TEMPLATES} templates.`);
      const saved: Template = { ...template, custom: true, updatedAt: Date.now() };
      if (index < 0) templates.push(saved);
      else templates[index] = saved;
      await write(templates);
      return saved;
    }),
    remove: (id) => serialize(async () => {
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
