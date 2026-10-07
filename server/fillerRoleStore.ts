// What each Tunarr filler list is for (station IDs, commercials, promos…),
// kept by the companion in LINEUP_DATA_DIR/filler-roles.json. Tunarr's lists
// carry no such field, and encoding it in list names would rename the user's
// data in Tunarr. The same file remembers which lists are built from a folder
// (a Tunarr library), folders waiting for their first list, and folders whose
// list the user deleted (so automatic pickup doesn't bring it back).
import { isFillerRole, type FillerFolders, type FillerLink, type FillerLinks, type FillerRole, type FillerRoles, type PendingFolder } from './fillerRoles.js';
import { createJsonFile, StoreError } from './jsonFile.js';

export const MAX_FILLER_ROLES = 1000;
const FILE = 'filler-roles.json';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FillerRoleStore = {
  readonly location: string;
  list(): Promise<FillerRoles>;
  set(listId: string, role: FillerRole): Promise<FillerRoles>;
  remove(listId: string): Promise<FillerRoles>;
  links(): Promise<FillerLinks>;
  folders(): Promise<FillerFolders>;
  /** Follows a list built from a library (and stops waiting for or ignoring that library). */
  link(listId: string, link: FillerLink): Promise<FillerLinks>;
  /** Stops following a list; `ignore` keeps its library from being picked up again. */
  unlink(listId: string, ignore?: boolean): Promise<FillerLinks>;
  /** Makes a list for this library once Tunarr has scanned it. */
  addPending(libraryId: string, folder: PendingFolder): Promise<void>;
};

type Data = FillerFolders & { roles: FillerRoles };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

export function createFillerRoleStore(dir: string): FillerRoleStore {
  const file = createJsonFile(dir, FILE, 'filler-list roles');

  async function read(): Promise<Data> {
    const data = (await file.read()) as Record<string, unknown> | undefined;
    const out: Data = { roles: {}, links: {}, pending: {}, ignored: [] };
    // Drop anything a hand edit broke rather than failing the whole desk.
    if (isRecord(data?.roles)) {
      for (const [id, role] of Object.entries(data.roles)) if (UUID.test(id) && isFillerRole(role)) out.roles[id] = role;
    }
    if (isRecord(data?.links)) {
      for (const [id, link] of Object.entries(data.links)) {
        if (UUID.test(id) && isRecord(link) && UUID.test(String(link.mediaSourceId)) && UUID.test(String(link.libraryId))) {
          out.links[id] = { mediaSourceId: link.mediaSourceId as string, libraryId: link.libraryId as string, ...(Number.isFinite(link.builtAt) ? { builtAt: link.builtAt as number } : {}) };
        }
      }
    }
    if (isRecord(data?.pending)) {
      for (const [id, folder] of Object.entries(data.pending)) {
        if (UUID.test(id) && isRecord(folder) && UUID.test(String(folder.mediaSourceId)) && isFillerRole(folder.role) && validName(folder.name)) {
          out.pending[id] = { mediaSourceId: folder.mediaSourceId as string, role: folder.role, name: folder.name };
        }
      }
    }
    if (Array.isArray(data?.ignored)) out.ignored = data.ignored.filter((id): id is string => typeof id === 'string' && UUID.test(id));
    return out;
  }

  // Folder bookkeeping appears only once used; older files stay as they were.
  const write = ({ roles, links, pending, ignored }: Data) => file.write({
    version: 1,
    roles,
    ...(Object.keys(links).length ? { links } : {}),
    ...(Object.keys(pending).length ? { pending } : {}),
    ...(ignored.length ? { ignored } : {}),
  });
  const full = (data: Data) => Object.keys(data.links).length + Object.keys(data.pending).length >= MAX_FILLER_ROLES;

  return {
    location: file.location,
    list: () => file.serialize(async () => (await read()).roles),
    set: (listId, role) => file.serialize(async () => {
      const data = await read();
      if (!(listId in data.roles) && Object.keys(data.roles).length >= MAX_FILLER_ROLES) throw new StoreError(409, 'too_many_roles', `You can tag up to ${MAX_FILLER_ROLES} filler lists.`);
      data.roles[listId] = role;
      await write(data);
      return data.roles;
    }),
    remove: (listId) => file.serialize(async () => {
      const data = await read();
      if (!(listId in data.roles)) return data.roles;
      delete data.roles[listId];
      await write(data);
      return data.roles;
    }),
    links: () => file.serialize(async () => (await read()).links),
    folders: () => file.serialize(async () => {
      const { links, pending, ignored } = await read();
      return { links, pending, ignored };
    }),
    link: (listId, link) => file.serialize(async () => {
      const data = await read();
      if (!(listId in data.links) && full(data)) throw new StoreError(409, 'too_many_links', `You can link up to ${MAX_FILLER_ROLES} filler lists to folders.`);
      // A library feeds one list; relinking moves it.
      for (const [id, existing] of Object.entries(data.links)) if (existing.libraryId === link.libraryId) delete data.links[id];
      data.links[listId] = { mediaSourceId: link.mediaSourceId, libraryId: link.libraryId, ...(Number.isFinite(link.builtAt) ? { builtAt: link.builtAt } : {}) };
      delete data.pending[link.libraryId];
      data.ignored = data.ignored.filter((id) => id !== link.libraryId);
      await write(data);
      return data.links;
    }),
    unlink: (listId, ignore = false) => file.serialize(async () => {
      const data = await read();
      const link = data.links[listId];
      if (!link) return data.links;
      delete data.links[listId];
      if (ignore && !data.ignored.includes(link.libraryId)) data.ignored.push(link.libraryId);
      await write(data);
      return data.links;
    }),
    addPending: (libraryId, folder) => file.serialize(async () => {
      const data = await read();
      if (!(libraryId in data.pending) && full(data)) throw new StoreError(409, 'too_many_links', `You can follow up to ${MAX_FILLER_ROLES} folders.`);
      data.pending[libraryId] = folder;
      data.ignored = data.ignored.filter((id) => id !== libraryId);
      await write(data);
    }),
  };
}
