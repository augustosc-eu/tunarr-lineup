// One JSON file in LINEUP_DATA_DIR, shared by the companion's small stores
// (saved templates, filler-list roles): serialized writes, atomic replace,
// and a file that can't be parsed is never overwritten.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type JsonFile = {
  readonly location: string;
  /** Runs reads and writes one at a time so two saves can't interleave and lose one. */
  serialize<T>(task: () => Promise<T>): Promise<T>;
  /** The parsed file, or undefined when it doesn't exist yet. */
  read(): Promise<unknown>;
  write(data: unknown): Promise<void>;
};

/** `what` names the contents in errors ("saved templates", "filler-list roles"). */
export function createJsonFile(dir: string, name: string, what: string): JsonFile {
  const file = path.join(dir, name);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    location: file,
    serialize<T>(task: () => Promise<T>) {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    },
    async read() {
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new StoreError(500, 'store_unreadable', `The ${what} could not be read.`);
      }
      try {
        return JSON.parse(raw);
      } catch {
        // Never overwrite a file we can't parse; the user may want to recover it.
        throw new StoreError(500, 'store_corrupt', `The ${what} file (${name}) is not valid JSON. Fix or move it, then try again.`);
      }
    },
    async write(data) {
      try {
        await mkdir(dir, { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
        await rename(tmp, file);
      } catch {
        throw new StoreError(500, 'store_unwritable', `The ${what} could not be saved. Check that LINEUP_DATA_DIR (${dir}) is writable.`);
      }
    },
  };
}
